import { config } from "../config.js";
import { db } from "../db.js";
import { searchKnowledge, type Retrieved } from "../knowledge/search.js";
import { signedUrl } from "../knowledge/storage.js";
import { addUsage, chatWithFallback, chat, emptyUsage, type ChatMessage, type Usage } from "../llm/client.js";
import { log } from "../log.js";
import { handOffToHuman, sendMessage, type OutgoingAttachment } from "../makecrm/client.js";
import { parseSpec, type AgentSpec } from "../spec/agent.js";
import { understandMedia } from "./media.js";
import { agentKeys } from "../secrets.js";
import { INTEGRATION_TOOL_NAMES, integrationTools, runIntegrationTool, type IntegrationCtx } from "../integrations/index.js";
import { parseGaps, recordGaps, type GapDraft } from "../insights/gap-capture.js";
import { recordCost, type CostSource } from "../costs/ledger.js";
import { normalizeReply, splitPlainText, typingDelayMs, type ReplyMessage } from "./output.js";
import { buildSystemPrompt, contextBlock } from "./prompt.js";
import { finishScenario, runScenario, SCENARIO_TOOL, scenarioTool, type ScenarioHit } from "./scenarios.js";
import { builtinTools, formatResults, RefRegistry, REPLY_TOOL } from "./tools.js";

/**
 * Uma "vez" do agente: pega as mensagens do lead ainda sem resposta, entende as
 * mídias, monta o contexto (histórico, resumo, dados do contato, conhecimento),
 * roda o LLM com as ferramentas e envia a resposta frase a frase.
 */

const MAX_ROUNDS = 6;
/**
 * O lead escreveu de novo enquanto o agente pensava: a resposta é descartada e
 * a próxima vez responde tudo junto — até a primeira mensagem esperar isto
 * (depois, responde mesmo assim para o lead não ficar sem resposta).
 */
const SUPERSEDE_MAX_MS = 90_000;

/** Ferramentas sem efeito fora da conversa: a resposta pode ser descartada e refeita. */
const SAFE_TO_REDO = new Set([REPLY_TOOL, "buscar_conhecimento", "registrar_dados_do_contato", "transferir_para_humano", "agenda_horarios_livres"]);

/** Chegou mensagem do lead depois das que esta vez está respondendo? */
async function newerLeadMessage(conversationId: string, afterId: string): Promise<boolean> {
  const [m] = await db()`
    select 1 from public.messages
    where conversation_id = ${conversationId} and role = 'user' and turn_id is null and id > ${afterId}
    limit 1`;
  return !!m;
}

export type ConversationRow = {
  id: string;
  agent_id: string;
  binding_id: string | null;
  company_id: string;
  external_id: string;
  simulation: boolean;
  phone: string | null;
  contact_name: string | null;
  mavi_user_id: string | null;
  summary: string;
  summary_upto: string | null;
  facts: Record<string, unknown>;
};

type MessageRow = {
  id: string;
  role: "user" | "assistant" | "note";
  content: string;
  content_type: string;
  media: { url?: string; description?: string; processed?: boolean; error?: string } | null;
  turn_id: string | null;
  created_at: Date;
};

export type TurnOptions = {
  conversationId: string;
  /** Simulação: usa este rascunho/versão e não envia nada ao MakeCRM. */
  spec?: AgentSpec;
  agentVersion?: number | null;
};

export type TurnResult = {
  turnId: string | null;
  status: "done" | "silent" | "error" | "skipped";
  /** O lead escreveu de novo antes do envio: a próxima vez responde tudo junto. */
  superseded?: boolean;
  messages: ReplyMessage[];
  attachments: Record<string, { url: string; mime: string; title: string }>;
  silentReason?: string;
  handoff?: string;
  error?: string;
};

// ---------------------------------------------------------------- especificação publicada (cache)

const specCache = new Map<string, AgentSpec>();

export async function publishedSpec(agentId: string): Promise<{ spec: AgentSpec; version: number } | null> {
  const [row] = await db()<{ status: string; published_version: number | null; archived_at: Date | null }[]>`
    select status, published_version, archived_at from public.agents where id = ${agentId}`;
  if (!row || row.archived_at || row.status !== "active" || !row.published_version) return null;
  const key = `${agentId}:${row.published_version}`;
  let spec = specCache.get(key);
  if (!spec) {
    const [v] = await db()<{ spec: unknown }[]>`
      select spec from public.agent_versions where agent_id = ${agentId} and version = ${row.published_version}`;
    const parsed = parseSpec(v?.spec);
    if (!parsed.ok) throw new Error(`Versão ${row.published_version} do agente inválida.`);
    spec = parsed.spec;
    if (specCache.size > 500) specCache.clear();
    specCache.set(key, spec);
  }
  return { spec, version: row.published_version };
}

/** O que as integrações e o follow-up precisam saber da conversa. */
export async function integrationCtx(conv: ConversationRow, spec: AgentSpec): Promise<IntegrationCtx> {
  const inboxId = conv.binding_id
    ? ((await db()<{ inbox_id: string }[]>`select inbox_id from public.bindings where id = ${conv.binding_id}`)[0]?.inbox_id ?? null)
    : null;
  return {
    agentId: conv.agent_id,
    agentName: spec.persona.name,
    spec,
    simulation: conv.simulation,
    conversationId: conv.id,
    makecrmConversationId: conv.simulation ? null : conv.external_id,
    inboxId,
    companyId: conv.company_id,
    maviUserId: conv.mavi_user_id,
    contactName: conv.contact_name,
    phone: conv.phone,
    facts: conv.facts,
    summary: conv.summary,
  };
}

// ---------------------------------------------------------------- a vez

export async function runTurn(opts: TurnOptions): Promise<TurnResult> {
  const sql = db();
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  let usage: Usage = emptyUsage();
  const toolLog: { name: string; args: unknown; result: string; ms: number }[] = [];

  const [conv] = await sql<ConversationRow[]>`select * from public.conversations where id = ${opts.conversationId}`;
  if (!conv) return { turnId: null, status: "skipped", messages: [], attachments: {} };

  let spec = opts.spec;
  let version: number | null = opts.agentVersion ?? null;
  if (!spec) {
    const p = await publishedSpec(conv.agent_id);
    if (!p) return { turnId: null, status: "skipped", messages: [], attachments: {} };
    spec = p.spec;
    version = p.version;
  }
  const live = !conv.simulation;

  // Mensagens do lead ainda sem resposta.
  const pending = await sql<MessageRow[]>`
    select id, role, content, content_type, media, turn_id, created_at from public.messages
    where conversation_id = ${conv.id} and role = 'user' and turn_id is null
    order by id`;
  if (!pending.length) return { turnId: null, status: "skipped", messages: [], attachments: {} };

  const [turnRow] = await sql<{ id: string }[]>`select gen_random_uuid() as id`;
  const turnId = turnRow!.id;
  const model = spec.model.model ?? config().DEFAULT_MODEL;
  const fallback = spec.model.fallback_model ?? config().FALLBACK_MODEL;
  // As chaves do próprio agente pagam as conversas dele; sem elas, as do motor.
  const keys = await agentKeys(conv.agent_id);
  const reg = new RefRegistry();
  let retrievedLog: { ref: string; chunk_id: string; kind: string; title: string; score: number; via: string }[] = [];

  try {
    // Cada gasto da vez vai separado para o registro de custos (o total fica no rastro).
    const cost = (source: CostSource, u: Usage, extra: { model?: string | null; messageId?: string; units?: number; meta?: Record<string, unknown> } = {}) =>
      recordCost({ agentId: conv.agent_id, conversationId: conv.id, turnId, simulation: conv.simulation, source, usage: u, ...extra });

    // 1. Mídias
    let tm = Date.now();
    for (const m of pending) {
      if (!m.media?.url || m.media.processed) continue;
      const r = await understandMedia(spec, m.content_type, m.media.url, m.content);
      usage = addUsage(usage, r.usage);
      await cost(MEDIA_SOURCE[m.content_type] ?? "media_document", r.usage, { model: r.model, messageId: m.id, units: r.units, meta: { content_type: m.content_type } });
      m.content = r.text;
      m.media = { ...m.media, processed: true, description: r.description, ...(r.error ? { error: r.error } : {}) };
      await sql`update public.messages set content = ${m.content}, media = ${sql.json(m.media as never)} where id = ${m.id}`;
    }
    timings.media = Date.now() - tm;

    // 2. Histórico (sem as pendentes) e resumo
    const history = await sql<MessageRow[]>`
      select * from (
        select id, role, content, content_type, media, turn_id from public.messages
        where conversation_id = ${conv.id} and role in ('user', 'assistant') and turn_id is not null
        order by id desc limit ${spec.memory.history_messages}
      ) h order by id`;

    // 3. Pré-busca no conhecimento
    tm = Date.now();
    const pendingText = pending.map((m) => m.content).filter(Boolean).join("\n");
    let prefetch: Retrieved[] = [];
    if (spec.knowledge.enabled && spec.knowledge.prefetch_k > 0 && pendingText.trim()) {
      const lastAssistant = [...history].reverse().find((h) => h.role === "assistant")?.content ?? "";
      // Mensagem curta ("e o preço?") precisa do assunto anterior para a busca.
      const query = pendingText.length < 60 && lastAssistant ? `${lastAssistant.slice(-300)}\n${pendingText}` : pendingText;
      const r = await searchKnowledge({ agentId: conv.agent_id, query, k: spec.knowledge.prefetch_k, rerank: spec.knowledge.rerank });
      usage = addUsage(usage, r.usage);
      await cost("retrieval", r.usage, { meta: { via: "prefetch" } });
      prefetch = r.results;
    }
    const retrievedForPrompt = prefetch.map((r) => ({ ref: reg.add(r), kind: r.kind, title: r.title, content: r.content }));
    retrievedLog = prefetch.map((r) => ({ ref: reg.add(r), chunk_id: r.chunk_id, kind: r.kind, title: r.title, score: r.score, via: "prefetch" }));
    timings.retrieval = Date.now() - tm;

    // 4. Mensagens para o LLM
    const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(spec) }];
    for (const h of history) {
      if (h.role === "user") messages.push({ role: "user", content: h.content });
      else messages.push({ role: "assistant", content: h.content });
    }
    messages.push({
      role: "user",
      content:
        `${pendingText || "(mensagem sem texto)"}\n\n` +
        contextBlock({ contactName: conv.contact_name, phone: conv.phone, facts: conv.facts, summary: spec.memory.summary ? conv.summary : "", retrieved: retrievedForPrompt }),
    });

    // 5. LLM + ferramentas
    tm = Date.now();
    const sc = scenarioTool(spec);
    const tools = [...builtinTools(spec), ...integrationTools(spec), ...(sc ? [sc] : [])];
    // O que as integrações precisam saber da conversa (MakeCRM, contato, resumo).
    const ictx = await integrationCtx(conv, spec);
    let reply: ReplyMessage[] | null = null;
    let silentReason: string | undefined;
    let handoff: string | undefined;
    let scenario: ScenarioHit | undefined;
    let gaps: GapDraft[] = [];
    let rounds = 0;
    let usedModel = model;

    while (rounds < MAX_ROUNDS && reply === null) {
      rounds++;
      const last = rounds === MAX_ROUNDS;
      const res = await chatWithFallback(
        {
          model,
          messages,
          tools: last ? tools.filter((t) => t.function.name === REPLY_TOOL) : tools,
          toolChoice: "required",
          temperature: spec.model.temperature,
          effort: spec.model.effort,
          maxTokens: 2000,
          keys,
          pricing: spec.model.pricing,
        },
        fallback,
        spec.model.fallback_pricing,
      );
      usage = addUsage(usage, res.usage);
      usedModel = res.model;
      await cost("reply", res.usage, { model: res.model, meta: { round: rounds } });
      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        // Provedor que ignorou "required": o texto vira a resposta.
        reply = splitPlainText(res.message.content ?? "", spec);
        break;
      }
      messages.push({ role: "assistant", content: res.message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const started = Date.now();
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        let result: string;
        switch (call.function.name) {
          case REPLY_TOOL: {
            reply = normalizeReply(args.mensagens, spec);
            if (!reply.length) silentReason = typeof args.motivo_silencio === "string" ? args.motivo_silencio : "sem motivo";
            gaps = parseGaps(args.lacunas);
            result = "ok";
            break;
          }
          case "buscar_conhecimento": {
            const kinds = typeof args.tipo === "string" ? [args.tipo] : null;
            const r = await searchKnowledge({ agentId: conv.agent_id, query: String(args.consulta ?? ""), k: 6, kinds, rerank: spec.knowledge.rerank });
            usage = addUsage(usage, r.usage);
            await cost("retrieval", r.usage, { meta: { via: "tool" } });
            result = formatResults(reg, r.results);
            for (const x of r.results) retrievedLog.push({ ref: reg.add(x), chunk_id: x.chunk_id, kind: x.kind, title: x.title, score: x.score, via: "tool" });
            break;
          }
          case "registrar_dados_do_contato": {
            const dados = args.dados && typeof args.dados === "object" ? (args.dados as Record<string, unknown>) : {};
            const clean = Object.fromEntries(
              Object.entries(dados)
                .filter(([, v]) => v != null && String(v).trim())
                .slice(0, 30)
                .map(([k, v]) => [k.slice(0, 60), String(v).slice(0, 500)]),
            );
            conv.facts = { ...conv.facts, ...clean };
            await sql`update public.conversations set facts = facts || ${sql.json(clean as never)} where id = ${conv.id}`;
            result = "Dados registrados.";
            break;
          }
          case "transferir_para_humano": {
            handoff = String(args.motivo ?? "").slice(0, 500) || "pedido de atendimento humano";
            result = "Transferência registrada. Agora avise o lead pela ferramenta responder.";
            break;
          }
          case SCENARIO_TOOL: {
            const r = await runScenario(spec, args, ictx);
            scenario ??= r.hit;
            result = r.result;
            break;
          }
          default:
            if (INTEGRATION_TOOL_NAMES.has(call.function.name)) {
              const r = await runIntegrationTool(call.function.name, args, ictx);
              result = r.result;
            } else result = "Ferramenta não disponível.";
        }
        toolLog.push({ name: call.function.name, args: call.function.name === REPLY_TOOL ? undefined : args, result: result.slice(0, 2000), ms: Date.now() - started });
        if (call.function.name !== REPLY_TOOL) messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    timings.llm = Date.now() - tm;
    reply ??= [];
    // Cenário com resposta combinada: a mensagem configurada (ou nenhuma) no lugar da do modelo.
    if (scenario?.scenario.reply === "fixed") reply = splitPlainText(scenario.scenario.message, spec);
    else if (scenario?.scenario.reply === "none") {
      reply = [];
      silentReason = `cenário: ${scenario.scenario.name}`;
    }

    // O lead mandou mais enquanto o agente pensava: descarta esta resposta (fica
    // no rastro, com o custo) e a próxima vez responde a tudo de uma vez.
    const lastPendingId = pending[pending.length - 1]!.id;
    // Se já marcou reunião, moveu oportunidade etc., não refaz (repetiria a ação): envia.
    const redoable = toolLog.every((t) => SAFE_TO_REDO.has(t.name));
    if (
      live &&
      redoable &&
      Date.now() - pending[0]!.created_at.getTime() < SUPERSEDE_MAX_MS &&
      (await newerLeadMessage(conv.id, lastPendingId))
    ) {
      timings.total = Date.now() - t0;
      await sql`
        insert into public.turns (id, conversation_id, agent_id, agent_version, simulation, status, input_message_ids, model, rounds,
                                  tokens_in, tokens_out, tokens_cached, cost_usd, timings, tools, retrieved, output)
        values (${turnId}, ${conv.id}, ${conv.agent_id}, ${version}, false, 'skipped', ${pending.map((m) => m.id)}::bigint[], ${usedModel}, ${rounds},
                ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd}, ${sql.json(timings as never)},
                ${sql.json(toolLog as never)}, ${sql.json(retrievedLog as never)},
                ${sql.json({ messages: reply, superseded: true, silent_reason: "o lead mandou outra mensagem antes do envio", handoff: null } as never)})`;
      return { turnId, status: "skipped", superseded: true, messages: [], attachments: {} };
    }

    // 6. Mídias citadas → anexos
    const attachments: TurnResult["attachments"] = {};
    for (const m of reply) {
      m.media = m.media.filter((ref) => {
        const r = reg.get(ref);
        if (!r || r.kind !== "media") return false;
        return true;
      });
      for (const ref of m.media) {
        const r = reg.get(ref)!;
        const meta = r.meta as { url?: string; storage_path?: string; mime?: string };
        const url = meta.storage_path ? await signedUrl(meta.storage_path) : meta.url;
        if (url) attachments[ref] = { url, mime: meta.mime ?? guessMime(url), title: r.title };
      }
      m.media = m.media.filter((ref) => attachments[ref]);
    }

    // 7. Envio (frase a frase) e transferência
    tm = Date.now();
    let sent = 0;
    let sendError: string | undefined;
    let interrupted = false;
    if (live) {
      try {
        for (let i = 0; i < reply.length; i++) {
          const m = reply[i]!;
          if (i > 0 && spec.output.typing_delay) await new Promise((r) => setTimeout(r, typingDelayMs(m.text)));
          // Como uma pessoa: o lead escreveu no meio, para de mandar o resto e lê.
          if (i > 0 && (await newerLeadMessage(conv.id, lastPendingId))) {
            interrupted = true;
            break;
          }
          await sendMessage({
            companyId: conv.company_id,
            userId: conv.mavi_user_id,
            conversationId: conv.external_id,
            content: m.text,
            attachments: m.media.map((ref, j) => toAttachment(attachments[ref]!, j + 1)),
          });
          sent++;
        }
      } catch (e) {
        sendError = e instanceof Error ? e.message : String(e);
        // Nada saiu: a vez falha e as mensagens do lead continuam pendentes.
        if (!sent) throw e;
        // Parte saiu: registra só o que foi enviado para não repetir depois.
        reply = reply.slice(0, sent);
      }
      // Interrompida pelo lead: fica registrado só o que saiu (a próxima vez continua dali).
      if (interrupted) reply = reply.slice(0, sent);
      if (handoff) {
        const [b] = await sql<{ inbox_id: string }[]>`select inbox_id from public.bindings where id = ${conv.binding_id}`;
        if (b) await handOffToHuman({ conversationId: conv.external_id, inboxId: b.inbox_id, reason: handoff });
      }
    }
    // Depois do envio: desliga a IA na conversa (se o cenário pedir), nota privada e registro.
    if (scenario) await finishScenario(scenario, ictx, turnId).catch((e) => log.warn({ err: String(e) }, "turn: cenário não concluído"));
    timings.send = Date.now() - tm;
    timings.total = Date.now() - t0;

    // 8. Registro
    const status = reply.length ? "done" : "silent";
    await sql.begin(async (tx) => {
      await tx`update public.messages set turn_id = ${turnId} where id in ${tx(pending.map((m) => m.id))}`;
      for (const m of reply!) {
        await tx`
          insert into public.messages (conversation_id, role, content, content_type, media, turn_id)
          values (${conv.id}, 'assistant', ${m.text}, ${m.media.length ? "media" : "text"},
                  ${m.media.length ? tx.json(m.media.map((ref) => attachments[ref]) as never) : null}, ${turnId})`;
      }
      if (handoff) {
        await tx`insert into public.messages (conversation_id, role, content, turn_id) values (${conv.id}, 'note', ${`Transferido para a equipe: ${handoff}`}, ${turnId})`;
      }
      if (scenario) {
        const note = `Cenário "${scenario.scenario.name}"${scenario.reason ? ` (${scenario.reason})` : ""}: ${scenario.done.join("; ") || "—"}`;
        await tx`insert into public.messages (conversation_id, role, content, turn_id) values (${conv.id}, 'note', ${note.slice(0, 2000)}, ${turnId})`;
      }
      await tx`update public.conversations set last_reply_at = now() where id = ${conv.id}`;
      await tx`
        insert into public.turns (id, conversation_id, agent_id, agent_version, simulation, status, input_message_ids, model, rounds,
                                  tokens_in, tokens_out, tokens_cached, cost_usd, timings, tools, retrieved, output, error)
        values (${turnId}, ${conv.id}, ${conv.agent_id}, ${version}, ${conv.simulation}, ${status}, ${pending.map((m) => m.id)}::bigint[], ${usedModel}, ${rounds},
                ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd}, ${tx.json(timings as never)},
                ${tx.json(toolLog as never)}, ${tx.json(retrievedLog as never)},
                ${tx.json({ messages: reply, silent_reason: silentReason ?? null, handoff: handoff ?? null, gaps, ...(scenario ? { scenario: { id: scenario.scenario.id, name: scenario.scenario.name, reason: scenario.reason, done: scenario.done } } : {}), ...(interrupted ? { interrupted: true } : {}) } as never)},
                ${sendError ? `Envio parcial: ${sendError}`.slice(0, 2000) : null})`;
    });

    // Lacunas do treinamento (só nas conversas reais; as simulações ficam no rastro).
    if (live && gaps.length) {
      await recordGaps({ agentId: conv.agent_id, conversationId: conv.id, turnId, leadText: pendingText, gaps }).catch((e) =>
        log.warn({ err: String(e) }, "turn: lacunas não gravadas"),
      );
    }

    // A régua de follow-up começa a contar a partir desta resposta (sem resposta ou passando para a equipe: não).
    const fu = spec.followup;
    const stopFollowup = !!scenario && (scenario.scenario.actions.stop_followup || scenario.scenario.actions.turn_off_ai);
    if (live && status === "done" && !handoff && !stopFollowup && fu?.enabled && fu.steps.length) {
      await sql`
        update public.conversations set followup_step = 0, followup_state = 'active',
          followup_next_at = now() + make_interval(mins => ${fu.steps[0]!.after_minutes})
        where id = ${conv.id}`;
    } else if (live && (handoff || stopFollowup)) {
      await sql`update public.conversations set followup_next_at = null, followup_state = 'idle' where id = ${conv.id}`;
    }

    // 9. Resumo das mensagens antigas (depois de responder, sem atrasar o lead)
    if (spec.memory.summary) await maybeSummarize(conv, spec).catch((e) => log.warn({ err: String(e) }, "turn: resumo falhou"));

    return { turnId, status, messages: reply, attachments, silentReason, handoff };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error({ conversationId: conv.id, err: error }, "turn: falhou");
    timings.total = Date.now() - t0;
    await sql`
      insert into public.turns (id, conversation_id, agent_id, agent_version, simulation, status, input_message_ids, model,
                                tokens_in, tokens_out, tokens_cached, cost_usd, timings, tools, retrieved, error)
      values (${turnId}, ${conv.id}, ${conv.agent_id}, ${version}, ${conv.simulation}, 'error', ${pending.map((m) => m.id)}::bigint[], ${model},
              ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd}, ${sql.json(timings as never)},
              ${sql.json(toolLog as never)}, ${sql.json(retrievedLog as never)}, ${error.slice(0, 2000)})`.catch(() => {});
    // As mensagens ficam pendentes: a próxima mensagem do lead tenta de novo com elas.
    return { turnId, status: "error", messages: [], attachments: {}, error };
  }
}

const MEDIA_SOURCE: Record<string, CostSource> = {
  ptt: "media_audio",
  audio: "media_audio",
  image: "media_image",
  sticker: "media_image",
  video: "media_video",
  document: "media_document",
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4",
  pdf: "application/pdf",
};
export function guessMime(url: string): string {
  const ext = new URL(url).pathname.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function toAttachment(a: { url: string; mime: string }, id: number): OutgoingAttachment {
  const [type = "image", sub = "png"] = a.mime.split("/");
  const kind = type === "application" ? "document" : type;
  return { id, type: kind, extension: sub.replace("jpeg", "jpg").replace(/\+.*/, ""), url: a.url, mime: a.mime };
}

// ---------------------------------------------------------------- resumo

/** Mantém um resumo das mensagens que saíram da janela do histórico. */
async function maybeSummarize(conv: ConversationRow, spec: AgentSpec) {
  const sql = db();
  const window = spec.memory.history_messages;
  const old = await sql<{ id: string; role: string; content: string }[]>`
    select id, role, content from public.messages
    where conversation_id = ${conv.id} and role in ('user', 'assistant') and turn_id is not null
      and id > ${conv.summary_upto ?? 0}
      and id < coalesce((
        select min(id) from (
          select id from public.messages where conversation_id = ${conv.id} and role in ('user', 'assistant') and turn_id is not null
          order by id desc limit ${window}
        ) w), 0)
    order by id`;
  // Só vale a pena resumir em blocos de 10+ mensagens.
  if (old.length < 10) return;
  const transcript = old.map((m) => `${m.role === "user" ? "Lead" : "Agente"}: ${m.content}`).join("\n").slice(-30_000);
  const r = await chat({
    model: config().UTILITY_MODEL,
    keys: await agentKeys(conv.agent_id),
    maxTokens: 700,
    timeoutMs: 60_000,
    messages: [
      {
        role: "system",
        content:
          "Atualize o resumo de uma conversa de WhatsApp entre um agente de atendimento e um lead. Mantenha: quem é o lead, o que ele quer, dados informados, o que já foi explicado/oferecido, combinados e pendências. Português, até 12 linhas, sem inventar.",
      },
      { role: "user", content: `Resumo atual:\n${conv.summary || "(vazio)"}\n\nNovas mensagens:\n${transcript}` },
    ],
  });
  await recordCost({ agentId: conv.agent_id, conversationId: conv.id, simulation: conv.simulation, source: "summary", usage: r.usage, model: r.model });
  const summary = (r.message.content ?? "").trim();
  if (summary) {
    await sql`update public.conversations set summary = ${summary}, summary_upto = ${old[old.length - 1]!.id} where id = ${conv.id}`;
  }
}
