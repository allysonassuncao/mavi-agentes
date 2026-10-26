import { randomInt } from "node:crypto";
import { db } from "../db.js";
import { inboxUazapi, type IntegrationCtx } from "../integrations/index.js";
import type { ActionDebug } from "../integrations/debug.js";
import { spLabel } from "../integrations/time.js";
import type { ToolDef } from "../llm/client.js";
import { log } from "../log.js";
import { conversationAiOn, handOffToHuman, rest } from "../makecrm/client.js";
import { scheduleIngest, scheduleTeam } from "../queue.js";
import { redis } from "../redis.js";
import type { AgentSpec } from "../spec/agent.js";
import { TEAM_TOOL, type TeamQuestionsT } from "../spec/team.js";
import { nextOpening } from "./followup.js";

/**
 * Consulta à equipe (a ferramenta consultar_equipe e o que vem depois): a
 * dúvida vai para a equipe pelo WhatsApp da caixa configurada, o agente segura
 * o lead e, quando a equipe responde (citando a mensagem, com o código ou —
 * havendo uma dúvida só em aberto — respondendo direto), o agente responde ao
 * lead numa vez própria (evento). A resposta chega pela entrada da caixa (se a
 * conversa da equipe estiver com a IA ligada) ou pela varredura das mensagens
 * do MakeCRM a cada minuto, que não depende disso.
 */

export type TeamQuestionRow = {
  id: string;
  agent_id: string;
  conversation_id: string;
  simulation: boolean;
  code: string;
  question: string;
  context: string;
  learn: boolean;
  status: "open" | "answered" | "expired" | "canceled";
  channel: { mode: "phones" | "group"; inbox_id: string; phones: string[]; group_id: string; group_name?: string };
  sent_ids: string[];
  asked_at: Date;
  due_at: Date | null;
  reminders: number;
  answer: string | null;
  answered_by: string | null;
  answered_at: Date | null;
  delivered_at: Date | null;
};

export const teamOn = (spec: AgentSpec): spec is AgentSpec & { team_questions: TeamQuestionsT } => !!spec.team_questions?.enabled;

/** Quanto tempo uma dúvida que já expirou ainda aceita resposta (o agente avisa o lead depois). */
const LATE_HOURS = 24;

// ---------------------------------------------------------------- ferramenta e instruções

export function teamTool(spec: AgentSpec): ToolDef[] {
  if (!teamOn(spec)) return [];
  const cfg = spec.team_questions;
  return [
    {
      type: "function",
      function: {
        name: TEAM_TOOL,
        description:
          "Pergunta à equipe da empresa algo que o lead quer saber e que você NÃO encontrou nas instruções, no conhecimento (pesquise antes com buscar_conhecimento) nem nas outras ferramentas. " +
          "Depois de chamar, avise o lead que vai confirmar e já retorna; não invente a resposta. Quando a equipe responder, você recebe a resposta e fala com o lead." +
          (cfg.when ? ` Consulte também: ${cfg.when}.` : "") +
          (cfg.never ? ` Nunca consulte sobre: ${cfg.never}.` : ""),
        parameters: {
          type: "object",
          properties: {
            pergunta: { type: "string", description: "A dúvida, clara e completa para quem não leu a conversa (ex.: \"Preço do Compass 2019 prata que o lead viu no anúncio\")." },
            contexto: { type: "string", description: "Opcional: o que mais a equipe precisa saber para responder." },
            pode_guardar: {
              type: "boolean",
              description: cfg.learn.enabled
                ? `true se a resposta vale para outros leads e não muda com o tempo (pode virar pergunta frequente). false para ${cfg.learn.skip}.`
                : "Sempre false.",
            },
          },
          required: ["pergunta", "pode_guardar"],
        },
      },
    },
  ];
}

/** As dúvidas em aberto desta conversa (vão no contexto de cada vez). */
export async function pendingTeamLine(conversationId: string): Promise<string | null> {
  const rows = await db()<{ question: string; asked_at: Date }[]>`
    select question, asked_at from public.team_questions
    where conversation_id = ${conversationId} and status = 'open' order by asked_at limit 5`;
  if (!rows.length) return null;
  return rows.map((r) => `"${r.question}" (perguntada há ${Math.max(0, Math.round((Date.now() - r.asked_at.getTime()) / 60_000))} min, ainda sem resposta)`).join("; ");
}

// ---------------------------------------------------------------- envio

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");

const masked = (phone: string | null) => (phone ? `${phone.slice(0, -4).replace(/\d/g, "•")}${phone.slice(-4)}` : "");

export function questionText(input: { agent: string; code: string; question: string; context: string; contact: string | null; phone: string | null; link: string; reminder?: number }): string {
  const head = input.reminder ? `⏰ Ainda sem resposta (${input.reminder}º lembrete) · #${input.code}` : `❓ ${input.agent} precisa de uma resposta · #${input.code}`;
  return [
    head,
    "",
    `*Dúvida do lead:* ${input.question}`,
    input.context ? `*Contexto:* ${input.context}` : null,
    `Contato: ${input.contact ?? "—"}${input.phone ? ` (${masked(input.phone)})` : ""}`,
    input.link || null,
    "",
    `Responda *citando esta mensagem* (ou comece com #${input.code}). O agente passa a resposta para o lead.`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** Os destinos do WhatsApp: os telefones ou o grupo. */
const targets = (ch: TeamQuestionRow["channel"]) => (ch.mode === "group" ? [ch.group_id] : ch.phones);

/** Manda pela Uazapi da caixa; devolve os ids das mensagens (para casar a citação). */
export async function sendToTeam(ch: TeamQuestionRow["channel"], text: string): Promise<{ ids: string[]; error: string | null }> {
  const uaz = await inboxUazapi(ch.inbox_id);
  if (!uaz) return { ids: [], error: "a caixa da consulta não é de WhatsApp por QR Code (Uazapi)" };
  const ids: string[] = [];
  let error: string | null = null;
  for (const number of targets(ch)) {
    try {
      const res = await fetch(`${uaz.base_url}/send/text`, {
        method: "POST",
        headers: { "content-type": "application/json", token: uaz.token },
        body: JSON.stringify({ number, text }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: unknown; messageid?: unknown; key?: { id?: unknown } };
      if (!res.ok) throw new Error(`Uazapi ${res.status}`);
      for (const v of [body.messageid, body.key?.id, body.id]) if (typeof v === "string" && v) ids.push(v.includes(":") ? v.split(":").pop()! : v);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log.warn({ err: error }, "consulta à equipe: envio falhou");
    }
  }
  return { ids: [...new Set(ids)], error: ids.length ? null : error };
}

function dueFrom(cfg: TeamQuestionsT, from: Date): Date {
  return nextOpening(cfg.window, new Date(from.getTime() + cfg.timeout.minutes * 60_000));
}

const conversationLink = (ctx: IntegrationCtx) =>
  ctx.makecrmConversationId && ctx.inboxId ? `https://app.usemakecrm.com.br/conversations/${ctx.inboxId}?chatId=${ctx.makecrmConversationId}` : "";

const words = (s: string) =>
  new Set(
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
/** Mesma dúvida? (a maioria das palavras em comum) */
export function sameQuestion(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size) >= 0.7;
}

export async function runTeamTool(args: Record<string, unknown>, ctx: IntegrationCtx, turnId: string): Promise<{ result: string; debug: ActionDebug }> {
  if (!teamOn(ctx.spec)) return { result: "Ferramenta não disponível.", debug: { outcome: "error", code: "team_off", summary: "Consulta à equipe desligada." } };
  const cfg = ctx.spec.team_questions;
  const question = String(args.pergunta ?? "").trim().slice(0, 1000);
  const context = String(args.contexto ?? "").trim().slice(0, 1000);
  if (!question) return { result: "Escreva a dúvida em pergunta.", debug: { outcome: "empty", code: "team_empty", summary: "Dúvida vazia." } };
  const sql = db();
  const open = await sql<TeamQuestionRow[]>`select * from public.team_questions where conversation_id = ${ctx.conversationId} and status = 'open'`;
  const dup = open.find((q) => sameQuestion(q.question, question));
  if (dup)
    return {
      result: `Você já perguntou isso à equipe ("${dup.question}") e ainda não houve resposta. Não pergunte de novo e não invente: diga ao lead que está confirmando e siga nos outros assuntos.`,
      debug: { outcome: "blocked", code: "team_duplicate", summary: `Já pendente: ${dup.question}` },
    };
  const channel = { mode: cfg.channel.mode, inbox_id: cfg.channel.inbox_id, phones: cfg.channel.phones, group_id: cfg.channel.group_id, group_name: cfg.channel.group_name };
  const learn = cfg.learn.enabled && args.pode_guardar === true;
  let code = newCode();
  for (let i = 0; i < 5 && (await sql`select 1 from public.team_questions where agent_id = ${ctx.agentId} and code = ${code} and status = 'open'`).length; i++) code = newCode();
  const now = new Date();
  const [row] = await sql<{ id: string }[]>`
    insert into public.team_questions (agent_id, conversation_id, simulation, code, question, context, learn, channel, due_at, turn_id)
    values (${ctx.agentId}, ${ctx.conversationId}, ${ctx.simulation}, ${code}, ${question}, ${context}, ${learn}, ${sql.json(channel as never)},
            ${ctx.simulation ? null : dueFrom(cfg, now)}, ${turnId})
    returning id`;
  const hold = "Diga ao lead, com naturalidade, que vai confirmar essa informação e já retorna; não invente a resposta. Siga a conversa nos outros assuntos.";
  if (ctx.simulation)
    return {
      result: `(Teste: nada foi enviado.) No ar, a equipe receberia a dúvida #${code}: "${question}". ${hold}`,
      debug: { outcome: "simulated", code: "team_asked", summary: `Dúvida #${code} para a equipe: ${question}`, details: [`question_id: ${row!.id}`] },
    };
  const text = questionText({ agent: ctx.agentName, code, question, context, contact: ctx.contactName, phone: ctx.phone, link: conversationLink(ctx) });
  const sent = await sendToTeam(channel, text);
  if (!sent.ids.length) {
    await sql`update public.team_questions set status = 'canceled', due_at = null, outcome = ${`não saiu: ${sent.error ?? "sem resposta da Uazapi"}`}, updated_at = now() where id = ${row!.id}`;
    return {
      result: "Não consegui falar com a equipe agora. Não invente a resposta: diga ao lead que vai confirmar e retornar, e siga a conversa.",
      debug: { outcome: "error", code: "team_send_failed", summary: `A dúvida não saiu: ${sent.error}`, hint: "Confira em Consulta à equipe se a caixa é de WhatsApp por QR Code e está conectada." },
    };
  }
  await sql`update public.team_questions set sent_ids = ${sent.ids}, updated_at = now() where id = ${row!.id}`;
  return {
    result: `Dúvida enviada à equipe (#${code}). ${hold}`,
    debug: { outcome: "ok", code: "team_asked", summary: `Dúvida #${code} enviada à equipe: ${question}` },
  };
}

// ---------------------------------------------------------------- a resposta da equipe

const digits = (s: string) => s.replace(/\D/g, "");
/** As formas do mesmo telefone (com e sem o 9 depois do DDD), como o MakeCRM guarda. */
export function phoneForms(phone: string): string[] {
  const d = digits(phone);
  const out = new Set([d]);
  if (d.startsWith("55") && d.length === 13 && d[4] === "9") out.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith("55") && d.length === 12) out.add(`${d.slice(0, 4)}9${d.slice(4)}`);
  return [...out];
}
const groupDigits = (g: string) => g.replace(/@g\.us$/, "");

/** Esta mensagem é de quem a dúvida foi mandada (telefone da equipe ou o grupo)? */
export function fromChannel(ch: TeamQuestionRow["channel"], sender: string): boolean {
  const s = digits(sender);
  if (!s) return false;
  if (ch.mode === "group") return groupDigits(ch.group_id).replace(/\D/g, "") === s || groupDigits(ch.group_id) === sender.replace(/@g\.us$/, "");
  return ch.phones.some((p) => phoneForms(p).includes(s) || phoneForms(s).includes(digits(p)));
}

/**
 * A qual dúvida a mensagem responde: a citada (reply_id), a do código ou —
 * com uma dúvida só em aberto naquele canal — ela. Devolve a resposta sem o código.
 */
export function matchAnswer(
  open: Pick<TeamQuestionRow, "id" | "code" | "sent_ids" | "asked_at">[],
  msg: { text: string; replyId: string | null; at: Date },
  allowSingle: boolean,
): { id: string; answer: string } | null {
  const text = msg.text.trim();
  if (!text) return null;
  if (msg.replyId) {
    const r = msg.replyId.includes(":") ? msg.replyId.split(":").pop()! : msg.replyId;
    const hit = open.find((q) => q.sent_ids.some((id) => id === r || id.endsWith(r) || r.endsWith(id)));
    if (hit) return { id: hit.id, answer: stripCode(text, hit.code) };
  }
  const m = text.toUpperCase().match(/#?\b([A-Z0-9]{4})\b/g) ?? [];
  for (const c of m) {
    const hit = open.find((q) => q.code === c.replace("#", ""));
    if (hit && (c.startsWith("#") || text.toUpperCase().startsWith(hit.code))) return { id: hit.id, answer: stripCode(text, hit.code) };
  }
  const before = open.filter((q) => q.asked_at.getTime() <= msg.at.getTime());
  if (allowSingle && before.length === 1 && !msg.replyId) return { id: before[0]!.id, answer: text };
  return null;
}

export const stripCode = (text: string, code: string) =>
  text
    .replace(new RegExp(`#?\\b${code}\\b[:\\-–\\s]*`, "i"), "")
    .trim() || text.trim();

/**
 * Guarda a resposta, ensina a base (se puder) e põe o agente para responder
 * ao lead. Devolve false se a dúvida já tinha resposta.
 */
export async function acceptAnswer(q: TeamQuestionRow, answer: string, by: string, source: "whatsapp" | "panel", messageId: string | null): Promise<boolean> {
  const sql = db();
  const [upd] = await sql<{ id: string }[]>`
    update public.team_questions set status = 'answered', answer = ${answer.slice(0, 4000)}, answered_by = ${by.slice(0, 200)}, answered_at = now(),
      answer_source = ${source}, answer_message_id = ${messageId}, due_at = null, updated_at = now()
    where id = ${q.id} and (status = 'open' or (status = 'expired' and asked_at > now() - make_interval(hours => ${LATE_HOURS})))
    returning id`;
  if (!upd) return false;
  if (q.learn) await learnFromAnswer(q, answer).catch((e) => log.warn({ err: String(e) }, "consulta à equipe: base não atualizada"));
  if (!q.simulation) {
    // Confirma para a equipe (sem citar o lead de novo).
    await sendToTeam(q.channel, `✅ Recebido (#${q.code}). Já passei a resposta para o lead.`).catch(() => {});
    await scheduleTeam({ conversationId: q.conversation_id, questionId: q.id, kind: "answer" });
  }
  return true;
}

/** A resposta vira pergunta frequente na base do agente ("veio da equipe"). */
async function learnFromAnswer(q: TeamQuestionRow, answer: string) {
  const [row] = await db()<{ id: string }[]>`
    insert into public.knowledge_items (agent_id, kind, title, body, data, source, created_by)
    values (${q.agent_id}, 'faq', ${q.question.slice(0, 300)}, ${answer},
            ${db().json({ question: q.question, answer, origin: "team", team_question_id: q.id } as never)},
            ${db().json({ type: "team", team_question_id: q.id } as never)}, 'Consulta à equipe')
    returning id`;
  await db()`update public.team_questions set knowledge_item_id = ${row!.id} where id = ${q.id}`;
  await scheduleIngest(row!.id);
}

/**
 * Uma mensagem que chegou pela entrada da caixa: se é a equipe respondendo uma
 * dúvida em aberto, trata aqui (e o motor não responde como se fosse lead).
 */
export async function teamInbound(agentId: string, inboxId: string, msg: { phone: string | null; text: string; replyId: string | null; sourceId: string | null; name: string | null }): Promise<boolean> {
  if (!msg.phone) return false;
  const open = await db()<TeamQuestionRow[]>`
    select * from public.team_questions
    where agent_id = ${agentId} and not simulation and channel->>'inbox_id' = ${inboxId}
      and (status = 'open' or (status = 'expired' and asked_at > now() - make_interval(hours => ${LATE_HOURS})))
    order by asked_at`;
  const mine = open.filter((q) => fromChannel(q.channel, msg.phone!));
  if (!mine.length) return false;
  return handleTeamMessage(mine, { text: msg.text, replyId: msg.replyId, sourceId: msg.sourceId, at: new Date(), by: msg.name ?? msg.phone, sender: msg.phone });
}

async function handleTeamMessage(
  candidates: TeamQuestionRow[],
  msg: { text: string; replyId: string | null; sourceId: string | null; at: Date; by: string; sender: string },
): Promise<boolean> {
  if (msg.sourceId) {
    const seen = await redis().set(`tq:seen:${msg.sourceId}`, "1", "EX", 2 * 86_400, "NX").catch(() => "OK");
    if (!seen) return true;
  }
  // A pessoa que é da equipe e também está falando como lead com o agente: só vale citando ou com o código.
  const leadPhones = await db()<{ id: string; phone: string | null }[]>`
    select id, phone from public.conversations where id = any (${candidates.map((q) => q.conversation_id)}::uuid[])`;
  const isLeadToo = leadPhones.some((c) => c.phone && phoneForms(c.phone).includes(digits(msg.sender)));
  const open = candidates.filter((q) => q.status === "open");
  const hit = matchAnswer(open.length ? open : candidates, msg, !isLeadToo && candidates[0]!.channel.mode === "phones");
  if (!hit) {
    // Quem também é lead e não citou nem mandou o código: é mensagem de lead.
    if (isLeadToo) return false;
    if (open.length > 1 && msg.text.trim())
      await sendToTeam(
        candidates[0]!.channel,
        `Não consegui saber a qual dúvida você respondeu. Responda *citando* a mensagem da dúvida (ou comece com o código):\n${open.map((q) => `#${q.code} — ${q.question}`).join("\n")}`,
      ).catch(() => {});
    return open.length > 0;
  }
  const q = candidates.find((c) => c.id === hit.id)!;
  await acceptAnswer(q, hit.answer, msg.by, "whatsapp", msg.sourceId);
  return true;
}

/** A cada minuto: procura nas conversas do MakeCRM as respostas da equipe às dúvidas em aberto. */
export async function teamRepliesTick(): Promise<number> {
  const open = await db()<TeamQuestionRow[]>`
    select q.* from public.team_questions q
    join public.agents a on a.id = q.agent_id and a.status = 'active' and a.archived_at is null
    where not q.simulation and (q.status = 'open' or (q.status = 'expired' and q.asked_at > now() - make_interval(hours => ${LATE_HOURS})))
    order by q.asked_at limit 300`;
  if (!open.length) return 0;
  const byInbox = new Map<string, TeamQuestionRow[]>();
  for (const q of open) byInbox.set(q.channel.inbox_id, [...(byInbox.get(q.channel.inbox_id) ?? []), q]);
  let n = 0;
  for (const [inboxId, qs] of byInbox) {
    const ids = [...new Set(qs.flatMap((q) => (q.channel.mode === "group" ? [groupDigits(q.channel.group_id)] : q.channel.phones.flatMap(phoneForms))))];
    if (!ids.length) continue;
    const convs = await rest<{ id: string; identifier: string }[]>(
      `inbox_conversations?select=id,identifier&inbox_id=eq.${encodeURIComponent(inboxId)}&identifier=in.(${ids.map((i) => `"${i}"`).join(",")})`,
    ).catch((e) => (log.warn({ err: String(e) }, "consulta à equipe: conversas não lidas"), []));
    if (!convs.length) continue;
    const since = new Date(Math.min(...qs.map((q) => q.asked_at.getTime()))).toISOString();
    const msgs = await rest<{ id: string; conversation_id: string; content: string | null; reply_id: string | null; source_id: string | null; created_at: string }[]>(
      `inbox_messages?select=id,conversation_id,content,reply_id,source_id,created_at&conversation_id=in.(${convs.map((c) => c.id).join(",")})` +
        `&message_type=eq.incoming&private=is.false&created_at=gt.${encodeURIComponent(since)}&order=created_at.asc&limit=200`,
    ).catch((e) => (log.warn({ err: String(e) }, "consulta à equipe: mensagens não lidas"), []));
    for (const m of msgs) {
      const conv = convs.find((c) => c.id === m.conversation_id)!;
      const at = new Date(m.created_at);
      // Só as dúvidas para aquele telefone/grupo, perguntadas antes da mensagem.
      const mine = qs.filter((q) => fromChannel(q.channel, conv.identifier) && q.asked_at.getTime() <= at.getTime() + 5_000);
      const fresh = await db()<{ id: string; status: string }[]>`select id, status from public.team_questions where id = any (${mine.map((q) => q.id)}::uuid[])`;
      const still = mine.filter((q) => fresh.some((f) => f.id === q.id && (f.status === "open" || f.status === "expired")));
      if (!still.length) continue;
      if (await handleTeamMessage(still, { text: m.content ?? "", replyId: m.reply_id, sourceId: m.source_id ?? m.id, at, by: conv.identifier, sender: conv.identifier })) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- sem resposta a tempo

/** A cada minuto: as dúvidas vencidas fazem a ação configurada. */
export async function teamTimeoutTick(): Promise<number> {
  const due = await db()<TeamQuestionRow[]>`
    select * from public.team_questions where status = 'open' and not simulation and due_at is not null and due_at <= now()
    order by due_at limit 200`;
  let n = 0;
  for (const q of due) {
    const { publishedSpec } = await import("./turn.js");
    const p = await publishedSpec(q.agent_id).catch(() => null);
    if (!p || !teamOn(p.spec)) {
      await db()`update public.team_questions set due_at = null, updated_at = now() where id = ${q.id}`;
      continue;
    }
    const cfg = p.spec.team_questions;
    if (cfg.timeout.action === "remind") {
      if (q.reminders >= cfg.timeout.max_reminders) {
        await db()`update public.team_questions set due_at = null, outcome = 'lembretes esgotados: seguindo à espera', updated_at = now() where id = ${q.id}`;
        continue;
      }
      const [conv] = await db()<{ contact_name: string | null; phone: string | null }[]>`select contact_name, phone from public.conversations where id = ${q.conversation_id}`;
      const text = questionText({ agent: p.spec.persona.name, code: q.code, question: q.question, context: q.context, contact: conv?.contact_name ?? null, phone: conv?.phone ?? null, link: "", reminder: q.reminders + 1 });
      const sent = await sendToTeam(q.channel, text);
      await db()`
        update public.team_questions set reminders = reminders + 1, sent_ids = sent_ids || ${sent.ids}::text[], due_at = ${dueFrom(cfg, new Date())}, updated_at = now()
        where id = ${q.id}`;
      n++;
      continue;
    }
    // Transferir ou desistir: a dúvida expira (uma resposta tardia ainda é aceita por 24 h).
    const [claimed] = await db()<{ id: string }[]>`
      update public.team_questions set status = 'expired', due_at = null, outcome = ${cfg.timeout.action === "handoff" ? "sem resposta: passou para uma pessoa" : "sem resposta: o agente avisou o lead"}, updated_at = now()
      where id = ${q.id} and status = 'open' returning id`;
    if (!claimed) continue;
    await scheduleTeam({ conversationId: q.conversation_id, questionId: q.id, kind: cfg.timeout.action === "handoff" ? "handoff" : "give_up" });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- de volta ao lead

/** O que o agente recebe na vez própria (a resposta chegou, ou não chegou a tempo). */
export function teamEventText(q: Pick<TeamQuestionRow, "question" | "answer" | "answered_by">, kind: "answer" | "give_up", guide = ""): string {
  if (kind === "answer")
    return (
      `A equipe respondeu à sua consulta "${q.question}": "${q.answer}". ` +
      "Responda agora ao lead com essa informação, de forma natural (sem dizer que perguntou a um sistema e sem citar o código), e siga a conversa de onde parou."
    );
  return (
    `A equipe não conseguiu responder a tempo à sua consulta "${q.question}". ` +
    `Diga ao lead, com naturalidade, que não conseguiu confirmar isso agora${guide ? ` e ${guide}` : ""}. Não invente a resposta. Se a equipe responder depois, você avisa.`
  );
}

/** A vez própria para a dúvida (job da fila, com a trava da conversa). */
export async function processTeamEvent(questionId: string, kind: "answer" | "give_up" | "handoff"): Promise<string> {
  const sql = db();
  const [q] = await sql<TeamQuestionRow[]>`select * from public.team_questions where id = ${questionId}`;
  if (!q || q.delivered_at) return "ignorado";
  const { publishedSpec, runTurn } = await import("./turn.js");
  const p = await publishedSpec(q.agent_id);
  const [conv] = await sql<{ external_id: string; binding_id: string | null }[]>`select external_id, binding_id from public.conversations where id = ${q.conversation_id}`;
  if (!p || !conv) return "pulado";
  const mark = (outcome: string, turnId: string | null) =>
    sql`update public.team_questions set delivered_at = now(), delivered_turn_id = ${turnId}, outcome = ${outcome.slice(0, 1000)}, updated_at = now() where id = ${q.id}`;
  if (kind === "handoff") {
    const [b] = conv.binding_id ? await sql<{ inbox_id: string }[]>`select inbox_id from public.bindings where id = ${conv.binding_id}` : [];
    if (b) await handOffToHuman({ conversationId: conv.external_id, inboxId: b.inbox_id, reason: `a equipe não respondeu a tempo à dúvida "${q.question}"` });
    await sql`insert into public.messages (conversation_id, role, content) values (${q.conversation_id}, 'note', ${`Consulta à equipe #${q.code} sem resposta em ${spLabel(new Date())}: passou para uma pessoa.`})`;
    await mark("sem resposta: passou para uma pessoa", null);
    return "transferido";
  }
  // Uma pessoa assumiu a conversa: não fala por cima (a resposta fica registrada).
  if (!(await conversationAiOn(conv.external_id).catch(() => true))) {
    await sql`insert into public.messages (conversation_id, role, content) values (${q.conversation_id}, 'note', ${`Consulta à equipe #${q.code}: ${kind === "answer" ? `resposta "${q.answer}"` : "sem resposta"} (a IA está desligada nesta conversa, o agente não falou).`})`;
    await mark("a IA está desligada na conversa: o agente não falou", null);
    return "pulado";
  }
  const guide = p.spec.team_questions?.timeout.give_up_guide ?? "";
  const r = await runTurn({
    conversationId: q.conversation_id,
    event: {
      text: teamEventText(q, kind, guide),
      note: kind === "answer" ? `Consulta à equipe #${q.code}: ${q.answered_by ?? "a equipe"} respondeu "${q.answer}"` : `Consulta à equipe #${q.code}: sem resposta a tempo`,
      query: q.question,
    },
  });
  await mark(kind === "answer" ? `resposta entregue ao lead (${r.status})` : `o agente avisou o lead (${r.status})`, r.turnId);
  return r.status;
}

/** Responder pela tela (o construtor, ou o simulador "como a equipe"). */
export async function answerFromPanel(q: TeamQuestionRow, answer: string, by: string): Promise<boolean> {
  return acceptAnswer(q, answer, by, "panel", null);
}
