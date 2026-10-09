import { config } from "../config.js";
import { db } from "../db.js";
import { chat } from "../llm/client.js";
import { log } from "../log.js";
import { publishedSpec } from "../runtime/turn.js";
import { agentKeys } from "../secrets.js";
import { recordCost } from "../costs/ledger.js";

/**
 * Leitura de cada conversa (na amostra do agente) quando ela esfria: intenção,
 * resultado e motivo, objeções, sentimento, assuntos e falhas do agente. É o
 * que alimenta os números e a Leitura da MAVI do relatório.
 *
 * A amostra é fixa por conversa (hash do id < percentual): a mesma conversa
 * está sempre dentro ou sempre fora, e mudar o percentual vale na hora.
 */

/** Horas sem mensagem para a conversa contar como "esfriou". */
export const QUIET_HOURS = 3;
/** Mais antiga que isto não é lida (para não ler o histórico todo de uma vez). */
const MAX_AGE_DAYS = 14;

export const OUTCOMES = ["scheduled", "purchased", "qualified", "handed_off", "in_progress", "not_interested", "ghosted", "disqualified", "other"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const ISSUE_TYPES = ["wrong_info", "ignored_question", "repetition", "overpromise", "tone", "missed_handoff", "other"] as const;

const OUTCOME_GUIDE = `- scheduled: marcou reunião/visita/demonstração
- purchased: comprou ou fechou
- qualified: interessado e qualificado, mas ainda sem compromisso marcado
- handed_off: passou para uma pessoa da equipe continuar
- in_progress: conversa em andamento, sem desfecho
- not_interested: disse que não quer / não tem interesse agora
- ghosted: parou de responder sem dizer nada
- disqualified: fora do perfil (não atende, curioso, errado, spam)
- other: nenhum dos anteriores`;

const ISSUE_GUIDE = `- wrong_info: deu informação errada ou inventou
- ignored_question: deixou uma pergunta do lead sem resposta
- repetition: repetiu a mesma coisa / entrou em círculo
- overpromise: prometeu o que não podia
- tone: tom inadequado (robótico, insistente, grosseiro)
- missed_handoff: devia ter passado para uma pessoa e não passou
- other: outra falha`;

type Candidate = { id: string; agent_id: string };

/** Conversas que esfriaram e ainda não foram lidas (ou têm mensagens novas). */
export async function dueConversations(limit: number): Promise<Candidate[]> {
  return db()<Candidate[]>`
    select c.id, c.agent_id from public.conversations c
    join public.agents a on a.id = c.agent_id and a.archived_at is null and a.insights_sample_percent > 0
    left join public.conversation_insights i on i.conversation_id = c.id
    where not c.simulation
      and greatest(c.last_inbound_at, c.last_reply_at) < now() - make_interval(hours => ${QUIET_HOURS})
      and greatest(c.last_inbound_at, c.last_reply_at) > now() - make_interval(days => ${MAX_AGE_DAYS})
      and mod(abs(hashtext(c.id::text)), 100) < a.insights_sample_percent
      and (i.conversation_id is null or (
        i.analyzed_at < now() - interval '12 hours'
        and exists (select 1 from public.messages m where m.conversation_id = c.id and m.id > i.last_message_id and m.role in ('user', 'assistant'))))
    order by greatest(c.last_inbound_at, c.last_reply_at) desc
    limit ${limit}`;
}

const clip = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function parseInsight(raw: unknown) {
  const j = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const outcome = (OUTCOMES as readonly string[]).includes(String(j.resultado)) ? (j.resultado as Outcome) : "other";
  const sentiment = ({ positivo: "positive", neutro: "neutral", negativo: "negative" } as Record<string, string>)[String(j.sentimento)] ?? "neutral";
  const labels = (v: unknown, n: number) =>
    Array.isArray(v) ? [...new Set(v.map((x) => clip(x, 60).toLowerCase()).filter(Boolean))].slice(0, n) : [];
  const issues = Array.isArray(j.falhas_do_agente)
    ? j.falhas_do_agente
        .map((x) => {
          const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
          const type = (ISSUE_TYPES as readonly string[]).includes(String(o.tipo)) ? String(o.tipo) : "other";
          return { type, detail: clip(o.detalhe, 300) };
        })
        .filter((x) => x.detail)
        .slice(0, 5)
    : [];
  return {
    intent: clip(j.intencao, 200),
    outcome,
    outcome_reason: clip(j.motivo, 400),
    reason_label: clip(j.motivo_curto, 60).toLowerCase(),
    sentiment,
    objections: labels(j.objecoes, 6),
    topics: labels(j.assuntos, 6),
    agent_issues: issues,
    summary: clip(j.resumo, 400),
  };
}

export async function analyzeConversation(conversationId: string): Promise<boolean> {
  const sql = db();
  const [conv] = await sql<{ id: string; agent_id: string; contact_name: string | null; facts: Record<string, unknown>; activity: Date }[]>`
    select id, agent_id, contact_name, facts, greatest(last_inbound_at, last_reply_at) as activity
    from public.conversations where id = ${conversationId}`;
  if (!conv?.activity) return false;
  const msgs = await sql<{ id: string; role: string; content: string; meta: Record<string, unknown> | null; created_at: Date }[]>`
    select * from (
      select id, role, content, meta, created_at from public.messages
      where conversation_id = ${conv.id} order by id desc limit 80
    ) m order by id`;
  const leadMessages = msgs.filter((m) => m.role === "user").length;
  if (!leadMessages) return false;
  const meetings = await sql<{ starts_at: Date; status: string }[]>`
    select starts_at, status from public.agent_meetings where conversation_id = ${conv.id} order by created_at`;
  const spec = (await publishedSpec(conv.agent_id).catch(() => null))?.spec;

  const who = (r: string) => (r === "user" ? "Lead" : r === "assistant" ? "Agente" : "Nota");
  const transcript = msgs
    .map((m) => `${who(m.role)}${m.meta && "followup" in m.meta ? " (follow-up)" : ""}: ${m.content}`)
    .join("\n")
    .slice(-24_000);
  const facts = Object.entries(conv.facts ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join("; ");

  const r = await chat({
    model: config().UTILITY_MODEL,
    keys: await agentKeys(conv.agent_id),
    json: true,
    effort: "low",
    maxTokens: 4000,
    timeoutMs: 60_000,
    messages: [
      {
        role: "system",
        content: [
          `Você analisa uma conversa de WhatsApp entre um agente de atendimento${spec ? ` (${spec.persona.name}, da ${spec.persona.company})` : ""} e um lead.`,
          spec ? `Objetivo do agente: ${spec.instructions.goal.slice(0, 600)}` : "",
          "Seja fiel à conversa, não invente. Responda só JSON com as chaves:",
          '{"intencao": "o que o lead quer, em poucas palavras",',
          ' "resultado": "uma das chaves abaixo",',
          ' "motivo": "por que terminou assim (uma frase)",',
          ' "motivo_curto": "o motivo em até 4 palavras, para agrupar (ex.: preço alto, sem tempo agora, já tem fornecedor)",',
          ' "sentimento": "positivo | neutro | negativo (do lead)",',
          ' "objecoes": ["objeções do lead, até 4 palavras cada"],',
          ' "assuntos": ["assuntos principais, até 3 palavras cada"],',
          ' "falhas_do_agente": [{"tipo": "chave abaixo", "detalhe": "o que aconteceu, uma frase"}],',
          ' "resumo": "a conversa em uma frase"}',
          `Resultado:\n${OUTCOME_GUIDE}`,
          `Falhas do agente (lista vazia se não houver):\n${ISSUE_GUIDE}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        role: "user",
        content: [
          conv.contact_name ? `Lead: ${conv.contact_name}` : "",
          facts ? `Dados coletados: ${facts}` : "",
          meetings.length ? `Reuniões marcadas pelo agente: ${meetings.map((m) => `${m.starts_at.toISOString()} (${m.status === "scheduled" ? "marcada" : "cancelada"})`).join(", ")}` : "",
          `Conversa:\n${transcript}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  await recordCost({ agentId: conv.agent_id, conversationId: conv.id, source: "insight", usage: r.usage, model: r.model });
  const ins = parseInsight(JSON.parse(r.message.content ?? "{}"));
  const lastId = msgs[msgs.length - 1]!.id;
  await sql`
    insert into public.conversation_insights (conversation_id, agent_id, last_message_id, activity_at, intent, outcome, outcome_reason, reason_label,
      sentiment, objections, topics, agent_issues, summary, lead_messages, model, cost_usd, analyzed_at)
    values (${conv.id}, ${conv.agent_id}, ${lastId}, ${conv.activity}, ${ins.intent}, ${ins.outcome}, ${ins.outcome_reason}, ${ins.reason_label},
      ${ins.sentiment}, ${ins.objections}, ${ins.topics}, ${sql.json(ins.agent_issues as never)}, ${ins.summary}, ${leadMessages}, ${r.model}, ${r.usage.costUsd}, now())
    on conflict (conversation_id) do update set
      last_message_id = excluded.last_message_id, activity_at = excluded.activity_at, intent = excluded.intent, outcome = excluded.outcome,
      outcome_reason = excluded.outcome_reason, reason_label = excluded.reason_label, sentiment = excluded.sentiment,
      objections = excluded.objections, topics = excluded.topics, agent_issues = excluded.agent_issues, summary = excluded.summary,
      lead_messages = excluded.lead_messages, model = excluded.model,
      cost_usd = public.conversation_insights.cost_usd + excluded.cost_usd, analyzed_at = now()`;
  return true;
}

/** Uma rodada: lê as conversas que esfriaram, algumas ao mesmo tempo. */
export async function analyzeDue(limit = 60, parallel = 6): Promise<number> {
  const due = await dueConversations(limit);
  let done = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(parallel, due.length) }, async () => {
    while (next < due.length) {
      const c = due[next++]!;
      try {
        if (await analyzeConversation(c.id)) done++;
      } catch (e) {
        log.warn({ conversationId: c.id, err: e instanceof Error ? e.message : String(e) }, "insights: leitura da conversa falhou");
      }
    }
  });
  await Promise.all(workers);
  return done;
}
