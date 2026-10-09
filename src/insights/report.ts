import { config } from "../config.js";
import { db } from "../db.js";
import { chat } from "../llm/client.js";
import { agentKeys } from "../secrets.js";

/**
 * Relatório do agente num período: números exatos dos registros do motor
 * (conversas, mensagens, transferências, reuniões, follow-up, custo, erros),
 * o que a leitura das conversas da amostra mostrou (resultados, motivos,
 * objeções, falhas do agente) e as lacunas do treinamento — sempre com o
 * período anterior do mesmo tamanho para comparar.
 */

const TZ = "America/Sao_Paulo";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export type Period = { from: string; to: string };

/** Período válido (até 366 dias) e o anterior do mesmo tamanho. */
export function periods(from: string, to: string): { cur: Period; prev: Period; days: number } {
  if (!YMD.test(from) || !YMD.test(to)) throw new Error("Período inválido (use AAAA-MM-DD).");
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  const days = Math.round((b - a) / 86_400_000) + 1;
  if (!(days >= 1 && days <= 366)) throw new Error("O período vai de 1 a 366 dias.");
  const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { cur: { from, to }, prev: { from: ymd(a - days * 86_400_000), to: ymd(a - 86_400_000) }, days };
}

type Metrics = {
  conversations: number;
  new_conversations: number;
  lead_messages: number;
  agent_messages: number;
  followup_messages: number;
  followup_recovered: number;
  turns: number;
  errors: number;
  handoffs: number;
  meetings: number;
  reply_ms_p50: number | null;
  cost_usd: number;
  insights_cost_usd: number;
};

async function metrics(agentId: string, p: Period): Promise<Metrics> {
  const sql = db();
  const [m] = await sql<Metrics[]>`
    with b as (
      select (${p.from}::date)::timestamp at time zone ${TZ} as s, ((${p.to}::date) + 1)::timestamp at time zone ${TZ} as e
    ),
    msg as (
      select m.conversation_id, m.id, m.role, m.meta from public.messages m
      join public.conversations c on c.id = m.conversation_id and c.agent_id = ${agentId} and not c.simulation, b
      where m.created_at >= b.s and m.created_at < b.e
    ),
    t as (
      select t.status, t.output, t.timings, t.cost_usd from public.turns t, b
      where t.agent_id = ${agentId} and not t.simulation and t.created_at >= b.s and t.created_at < b.e
    )
    select
      (select count(distinct conversation_id) from msg where role = 'user')::int as conversations,
      (select count(*) from public.conversations c, b where c.agent_id = ${agentId} and not c.simulation and c.created_at >= b.s and c.created_at < b.e)::int as new_conversations,
      (select count(*) from msg where role = 'user')::int as lead_messages,
      (select count(*) from msg where role = 'assistant')::int as agent_messages,
      (select count(*) from msg where role = 'assistant' and meta ? 'followup')::int as followup_messages,
      (select count(distinct u.conversation_id) from msg u
        where u.role = 'user' and (
          select p.meta ? 'followup' from public.messages p
          where p.conversation_id = u.conversation_id and p.id < u.id and p.role in ('user', 'assistant')
          order by p.id desc limit 1))::int as followup_recovered,
      (select count(*) from t)::int as turns,
      (select count(*) from t where status = 'error')::int as errors,
      (select count(*) from t where output->>'handoff' is not null)::int as handoffs,
      (select count(*) from public.agent_meetings g, b where g.agent_id = ${agentId} and g.created_at >= b.s and g.created_at < b.e and g.status = 'scheduled')::int as meetings,
      (select percentile_cont(0.5) within group (order by (timings->>'total')::numeric) from t where status = 'done' and timings ? 'total')::int as reply_ms_p50,
      (select coalesce(sum(cost_usd), 0) from t)::float8 as cost_usd,
      (select coalesce(sum(i.cost_usd), 0) from public.conversation_insights i, b where i.agent_id = ${agentId} and i.activity_at >= b.s and i.activity_at < b.e)::float8 as insights_cost_usd`;
  return m!;
}

async function series(agentId: string, p: Period) {
  const sql = db();
  const days = await sql<{ day: string; conversations: number; lead_messages: number; handoffs: number; meetings: number }[]>`
    with d as (select generate_series(${p.from}::date, ${p.to}::date, interval '1 day')::date as day),
    msg as (
      select (m.created_at at time zone ${TZ})::date as day, m.conversation_id from public.messages m
      join public.conversations c on c.id = m.conversation_id and c.agent_id = ${agentId} and not c.simulation
      where m.role = 'user' and m.created_at >= (${p.from}::date)::timestamp at time zone ${TZ}
        and m.created_at < ((${p.to}::date) + 1)::timestamp at time zone ${TZ}
    )
    select to_char(d.day, 'YYYY-MM-DD') as day,
      (select count(distinct conversation_id) from msg where msg.day = d.day)::int as conversations,
      (select count(*) from msg where msg.day = d.day)::int as lead_messages,
      (select count(*) from public.turns t where t.agent_id = ${agentId} and not t.simulation and t.output->>'handoff' is not null
        and (t.created_at at time zone ${TZ})::date = d.day)::int as handoffs,
      (select count(*) from public.agent_meetings g where g.agent_id = ${agentId} and g.status = 'scheduled'
        and (g.created_at at time zone ${TZ})::date = d.day)::int as meetings
    from d order by d.day`;
  const hours = await sql<{ hour: number; lead_messages: number }[]>`
    select extract(hour from m.created_at at time zone ${TZ})::int as hour, count(*)::int as lead_messages
    from public.messages m join public.conversations c on c.id = m.conversation_id and c.agent_id = ${agentId} and not c.simulation
    where m.role = 'user' and m.created_at >= (${p.from}::date)::timestamp at time zone ${TZ}
      and m.created_at < ((${p.to}::date) + 1)::timestamp at time zone ${TZ}
    group by 1 order by 1`;
  return { days, hours };
}

const LOST = ["not_interested", "ghosted", "disqualified"];

async function insightsOf(agentId: string, p: Period) {
  const sql = db();
  const range = sql`i.agent_id = ${agentId} and i.activity_at >= (${p.from}::date)::timestamp at time zone ${TZ}
    and i.activity_at < ((${p.to}::date) + 1)::timestamp at time zone ${TZ}`;
  const [totals] = await sql<{ analyzed: number }[]>`select count(*)::int as analyzed from public.conversation_insights i where ${range}`;
  const outcomes = await sql<{ outcome: string; n: number }[]>`
    select outcome, count(*)::int as n from public.conversation_insights i where ${range} group by 1 order by 2 desc`;
  const sentiment = await sql<{ sentiment: string; n: number }[]>`
    select sentiment, count(*)::int as n from public.conversation_insights i where ${range} group by 1`;
  const reasons = await sql<{ label: string; n: number; conversations: string[] }[]>`
    select reason_label as label, count(*)::int as n, (array_agg(conversation_id::text order by activity_at desc))[1:5] as conversations
    from public.conversation_insights i where ${range} and outcome in ${sql(LOST)} and reason_label <> ''
    group by 1 order by 2 desc limit 8`;
  const objections = await sql<{ label: string; n: number; conversations: string[] }[]>`
    select o as label, count(*)::int as n, (array_agg(i.conversation_id::text order by i.activity_at desc))[1:5] as conversations
    from public.conversation_insights i, unnest(i.objections) o where ${range}
    group by 1 order by 2 desc limit 10`;
  const topics = await sql<{ label: string; n: number }[]>`
    select t as label, count(*)::int as n from public.conversation_insights i, unnest(i.topics) t where ${range}
    group by 1 order by 2 desc limit 10`;
  const issues = await sql<{ type: string; n: number; examples: { conversation_id: string; detail: string }[] }[]>`
    select x->>'type' as type, count(*)::int as n,
      (array_agg(jsonb_build_object('conversation_id', i.conversation_id, 'detail', x->>'detail') order by i.activity_at desc))[1:4] as examples
    from public.conversation_insights i, jsonb_array_elements(i.agent_issues) x where ${range}
    group by 1 order by 2 desc`;
  return { analyzed: totals!.analyzed, outcomes, sentiment, reasons, objections, topics, issues };
}

/** Conversas que pedem um olhar: lead insatisfeito, falha do agente ou passou para a equipe. */
async function toLookAt(agentId: string, p: Period, limit = 12) {
  return db()`
    select i.conversation_id, c.external_id, c.contact_name, c.phone, i.outcome, i.sentiment, i.summary, i.agent_issues, i.activity_at
    from public.conversation_insights i join public.conversations c on c.id = i.conversation_id
    where i.agent_id = ${agentId} and i.activity_at >= (${p.from}::date)::timestamp at time zone ${TZ}
      and i.activity_at < ((${p.to}::date) + 1)::timestamp at time zone ${TZ}
      and (i.sentiment = 'negative' or jsonb_array_length(i.agent_issues) > 0 or i.outcome = 'handed_off')
    order by jsonb_array_length(i.agent_issues) desc, (i.sentiment = 'negative') desc, i.activity_at desc
    limit ${limit}`;
}

/** Cobertura: das respostas reais, quantas não tiveram lacuna. */
export async function gapStats(agentId: string, p: Period) {
  const sql = db();
  const [r] = await sql<{ turns: number; gap_turns: number; gaps: number; new_topics: number }[]>`
    with b as (
      select (${p.from}::date)::timestamp at time zone ${TZ} as s, ((${p.to}::date) + 1)::timestamp at time zone ${TZ} as e
    )
    select
      (select count(*) from public.turns t, b where t.agent_id = ${agentId} and not t.simulation and t.status = 'done' and t.created_at >= b.s and t.created_at < b.e)::int as turns,
      (select count(distinct g.turn_id) from public.gaps g, b where g.agent_id = ${agentId} and g.created_at >= b.s and g.created_at < b.e)::int as gap_turns,
      (select count(*) from public.gaps g, b where g.agent_id = ${agentId} and g.created_at >= b.s and g.created_at < b.e)::int as gaps,
      (select count(*) from public.gap_topics t, b where t.agent_id = ${agentId} and t.first_seen_at >= b.s and t.first_seen_at < b.e)::int as new_topics`;
  const coverage = r!.turns ? Math.max(0, 1 - r!.gap_turns / r!.turns) : null;
  return { ...r!, coverage };
}

async function topGaps(agentId: string, p: Period, limit = 6) {
  return db()`
    select t.id, t.kind, t.title, t.category, t.status, count(g.id)::int as in_period, t.occurrences
    from public.gap_topics t join public.gaps g on g.topic_id = t.id
    where t.agent_id = ${agentId} and t.status = 'open'
      and g.created_at >= (${p.from}::date)::timestamp at time zone ${TZ}
      and g.created_at < ((${p.to}::date) + 1)::timestamp at time zone ${TZ}
    group by t.id order by in_period desc, t.last_seen_at desc limit ${limit}`;
}

export async function buildReport(agentId: string, from: string, to: string) {
  const { cur, prev, days } = periods(from, to);
  const [sample] = await db()<{ insights_sample_percent: number }[]>`select insights_sample_percent from public.agents where id = ${agentId}`;
  const [m, mPrev, s, ins, insPrev, look, gaps, gapsPrev, top] = await Promise.all([
    metrics(agentId, cur),
    metrics(agentId, prev),
    series(agentId, cur),
    insightsOf(agentId, cur),
    insightsOf(agentId, prev),
    toLookAt(agentId, cur),
    gapStats(agentId, cur),
    gapStats(agentId, prev),
    topGaps(agentId, cur),
  ]);
  return {
    period: cur,
    previous: prev,
    days,
    sample_percent: sample?.insights_sample_percent ?? 0,
    metrics: m,
    previous_metrics: mPrev,
    series: s,
    insights: ins,
    previous_insights: { analyzed: insPrev.analyzed, outcomes: insPrev.outcomes, sentiment: insPrev.sentiment },
    look_at: look,
    gaps: { ...gaps, top },
    previous_gaps: gapsPrev,
  };
}

export type Report = Awaited<ReturnType<typeof buildReport>>;

// ---------------------------------------------------------------- Leitura da MAVI

export type Reading = {
  summary: string;
  points: { kind: "good" | "attention" | "action"; title: string; text: string; conversations: string[] }[];
};

const OUTCOME_PT: Record<string, string> = {
  scheduled: "agendou", purchased: "comprou", qualified: "qualificado sem compromisso", handed_off: "passou para a equipe",
  in_progress: "em andamento", not_interested: "sem interesse", ghosted: "parou de responder", disqualified: "fora do perfil", other: "outro",
};
const SENTIMENT_PT: Record<string, string> = { positive: "positivo", neutral: "neutro", negative: "negativo" };
const ISSUE_PT: Record<string, string> = {
  wrong_info: "informação errada", ignored_question: "pergunta sem resposta", repetition: "repetição", overpromise: "prometeu demais",
  tone: "tom inadequado", missed_handoff: "não passou para a equipe", other: "outra falha",
};
const pt = (map: Record<string, string>, k: string) => map[k] ?? k;

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
const delta = (a: number, b: number) => (b ? `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : a ? "novo" : "0");

/** O relatório em texto compacto para o modelo; C1, C2… são conversas que ele pode citar. */
export function reportDigest(r: Report, refs: Map<string, string>): string {
  const ref = (id: string) => {
    if (!refs.has(id)) refs.set(id, `C${refs.size + 1}`);
    return refs.get(id)!;
  };
  const m = r.metrics;
  const p = r.previous_metrics;
  const lines = [
    `Período: ${r.period.from} a ${r.period.to} (${r.days} dias); comparação com ${r.previous.from} a ${r.previous.to}.`,
    `Conversas com mensagem do lead: ${m.conversations} (${delta(m.conversations, p.conversations)}); novas: ${m.new_conversations} (${delta(m.new_conversations, p.new_conversations)}).`,
    `Mensagens: ${m.lead_messages} do lead, ${m.agent_messages} do agente. Erros nas respostas: ${m.errors} de ${m.turns}.`,
    `Passou para a equipe: ${m.handoffs} (${delta(m.handoffs, p.handoffs)}). Reuniões marcadas: ${m.meetings} (${delta(m.meetings, p.meetings)}).`,
    `Follow-up: ${m.followup_messages} enviados; ${m.followup_recovered} conversas voltaram depois de um follow-up (antes: ${p.followup_recovered}).`,
    m.reply_ms_p50 != null ? `Tempo típico de resposta: ${Math.round(m.reply_ms_p50 / 1000)} s.` : "",
    `Custo: US$ ${(m.cost_usd + m.insights_cost_usd).toFixed(2)}.`,
    "",
    `Leitura das conversas: ${r.insights.analyzed} conversas lidas (amostra de ${r.sample_percent}%).`,
    `Resultados: ${r.insights.outcomes.map((o) => `${pt(OUTCOME_PT, o.outcome)} ${o.n} (${pct(o.n, r.insights.analyzed)})`).join(", ") || "—"}.`,
    `Resultados no período anterior: ${r.previous_insights.outcomes.map((o) => `${pt(OUTCOME_PT, o.outcome)} ${o.n} (${pct(o.n, r.previous_insights.analyzed)})`).join(", ") || "—"}.`,
    `Sentimento: ${r.insights.sentiment.map((s) => `${pt(SENTIMENT_PT, s.sentiment)} ${s.n}`).join(", ") || "—"}.`,
    `Motivos de perda: ${r.insights.reasons.map((x) => `${x.label} ${x.n} [${x.conversations.slice(0, 3).map(ref).join(",")}]`).join("; ") || "—"}.`,
    `Objeções: ${r.insights.objections.map((x) => `${x.label} ${x.n} [${x.conversations.slice(0, 3).map(ref).join(",")}]`).join("; ") || "—"}.`,
    `Assuntos: ${r.insights.topics.map((x) => `${x.label} ${x.n}`).join(", ") || "—"}.`,
    `Falhas do agente: ${
      r.insights.issues.map((x) => `${pt(ISSUE_PT, x.type)} ${x.n} (ex.: ${x.examples.slice(0, 2).map((e) => `${ref(e.conversation_id)} ${e.detail}`).join(" | ")})`).join("; ") || "nenhuma"
    }.`,
    "",
    `Lacunas do treinamento: cobertura ${r.gaps.coverage == null ? "—" : pct(Math.round(r.gaps.coverage * 1000), 1000)} (antes: ${
      r.previous_gaps.coverage == null ? "—" : pct(Math.round(r.previous_gaps.coverage * 1000), 1000)
    }); ${r.gaps.gaps} ocorrências; ${r.gaps.new_topics} temas novos.`,
    `Lacunas mais frequentes: ${(r.gaps.top as unknown as { title: string; kind: string; in_period: number }[]).map((t) => `"${t.title}" (${t.kind === "objection" ? "objeção" : "pergunta"}, ${t.in_period}x)`).join("; ") || "—"}.`,
    "",
    "Conversas para olhar:",
    ...(r.look_at as unknown as { conversation_id: string; summary: string; outcome: string; sentiment: string }[]).map(
      (c) => `${ref(c.conversation_id)}: ${c.summary} (${pt(OUTCOME_PT, c.outcome)}, ${pt(SENTIMENT_PT, c.sentiment)})`,
    ),
  ];
  return lines.join("\n");
}

export async function generateReading(agentId: string, r: Report): Promise<{ reading: Reading; model: string; cost: number }> {
  const refs = new Map<string, string>();
  const digest = reportDigest(r, refs);
  const back = new Map([...refs].map(([id, c]) => [c, id]));
  const res = await chat({
    model: config().DEFAULT_MODEL,
    keys: await agentKeys(agentId),
    json: true,
    effort: "low",
    maxTokens: 5000,
    timeoutMs: 120_000,
    messages: [
      {
        role: "system",
        content: [
          "Você é a MAVI e escreve a leitura de um período de um agente de atendimento no WhatsApp para o gestor, em português do Brasil.",
          "Diga o que aconteceu, o que mudou em relação ao período anterior, o que preocupa e o que fazer. Seja concreto, use os números, sem enrolar.",
          "Não invente nada que não esteja nos dados. Amostra pequena (poucas conversas lidas) = diga que é um indício.",
          'Cite as conversas que sustentam cada ponto pelos códigos C1, C2… dos dados, só no campo "conversas" (nunca no texto).',
          'Responda só JSON: {"resumo": "2 a 4 frases", "pontos": [{"tipo": "bom | atencao | acao", "titulo": "curto", "texto": "1 a 3 frases", "conversas": ["C1"]}]} com 3 a 6 pontos.',
        ].join("\n"),
      },
      { role: "user", content: digest },
    ],
  });
  const j = JSON.parse(res.message.content ?? "{}") as { resumo?: unknown; pontos?: unknown };
  // Os códigos das conversas não aparecem no texto (as evidências vão em "conversations").
  const noRefs = (t: unknown) => String(t ?? "").replace(/\s*\(?\bC\d+(?:\s*[,e]\s*C\d+)*\)?/g, "").replace(/\s+([.,;:])/g, "$1").trim();
  const kindOf = (v: unknown): Reading["points"][number]["kind"] => (v === "bom" ? "good" : v === "acao" ? "action" : "attention");
  const points = (Array.isArray(j.pontos) ? j.pontos : [])
    .map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      return {
        kind: kindOf(o.tipo),
        title: noRefs(o.titulo).slice(0, 120),
        text: noRefs(o.texto).slice(0, 800),
        // Só conversas que existem nos dados (o modelo não inventa evidência).
        conversations: (Array.isArray(o.conversas) ? o.conversas : []).map((c) => back.get(String(c).trim())).filter((c): c is string => !!c).slice(0, 5),
      };
    })
    .filter((x) => x.title && x.text)
    .slice(0, 6);
  return { reading: { summary: noRefs(j.resumo).slice(0, 1500), points }, model: res.model, cost: res.usage.costUsd };
}
