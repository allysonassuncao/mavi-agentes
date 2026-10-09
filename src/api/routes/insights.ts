import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { applyToTraining, mergeTopics, suggestForTopic } from "../../insights/gaps.js";
import { OUTCOMES } from "../../insights/analyze.js";
import { buildReport, generateReading, gapStats, periods } from "../../insights/report.js";
import { assertUuid, HttpError, notFound, parseBody } from "../http.js";
import { loadAgent } from "./agents.js";

/**
 * Lacunas do treinamento e insights das conversas, para o construtor:
 * temas de perguntas/objeções sem resposta (sugerir, aplicar, ignorar,
 * juntar), relatório do período e a Leitura da MAVI.
 */

const TZ = "America/Sao_Paulo";

function period(q: { from?: string; to?: string }) {
  try {
    return periods(String(q.from ?? ""), String(q.to ?? ""));
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "Período inválido.");
  }
}

type TopicRow = { id: string; agent_id: string; status: string };
/** O tema pelo endereço do agente (/v1/agents/:id/gap-topics/:tid): só temas daquele agente. */
async function loadTopic(req: FastifyRequest): Promise<TopicRow> {
  const { id, tid } = req.params as { id: string; tid: string };
  const a = await loadAgent(req, id);
  assertUuid(tid, "Tema");
  const [t] = await db()<TopicRow[]>`select id, agent_id, status from public.gap_topics where id = ${tid} and agent_id = ${a.id}`;
  if (!t) throw notFound("Tema");
  return t;
}

const llmError = (e: unknown, what: string) => new HttpError(502, `${what}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));

export async function insightRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- lacunas
  app.get("/v1/agents/:id/gaps", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { from?: string; to?: string; status?: string; kind?: string };
    const { cur, prev } = period(q);
    const status = ["open", "trained", "ignored"].includes(String(q.status)) ? String(q.status) : null;
    const kind = ["question", "objection"].includes(String(q.kind)) ? String(q.kind) : null;
    const sql = db();
    const topics = await sql`
      with b as (
        select (${cur.from}::date)::timestamp at time zone ${TZ} as s, ((${cur.to}::date) + 1)::timestamp at time zone ${TZ} as e,
               (${prev.from}::date)::timestamp at time zone ${TZ} as ps
      )
      select t.id, t.kind, t.title, t.title_source, t.category, t.status, t.occurrences, t.conversations, t.after_trained,
             t.first_seen_at, t.last_seen_at, t.trained_at, t.trained_by, t.knowledge_item_id, (t.suggestion is not null) as has_suggestion,
             count(g.id) filter (where g.created_at >= b.s and g.created_at < b.e)::int as in_period,
             count(g.id) filter (where g.created_at >= b.ps and g.created_at < b.s)::int as in_previous,
             count(distinct g.conversation_id) filter (where g.created_at >= b.s and g.created_at < b.e)::int as conversations_in_period
      from public.gap_topics t cross join b
      left join public.gaps g on g.topic_id = t.id and g.created_at >= b.ps and g.created_at < b.e
      where t.agent_id = ${a.id}
        and (${status}::text is null or t.status = ${status})
        and (${kind}::text is null or t.kind = ${kind})
      group by t.id, b.s, b.e, b.ps
      order by (t.status = 'open') desc, in_period desc, t.occurrences desc, t.last_seen_at desc
      limit 500`;
    const [stats, statsPrev, pending] = await Promise.all([
      gapStats(a.id, cur),
      gapStats(a.id, prev),
      sql<{ n: number }[]>`select count(*)::int as n from public.gaps where agent_id = ${a.id} and topic_id is null`,
    ]);
    return { period: cur, previous: prev, topics, stats, previous_stats: statsPrev, pending: pending[0]!.n };
  });

  app.get("/v1/agents/:id/gap-topics/:tid", async (req) => {
    const t = await loadTopic(req);
    const [topic] = await db()`
      select id, agent_id, kind, title, title_source, category, status, occurrences, conversations, after_trained, suggestion,
             knowledge_item_id, trained_at, trained_by, first_seen_at, last_seen_at
      from public.gap_topics where id = ${t.id}`;
    const examples = await db()`
      select g.id, g.text, g.lead_text, g.created_at, g.conversation_id, c.external_id, c.contact_name, c.phone
      from public.gaps g join public.conversations c on c.id = g.conversation_id
      where g.topic_id = ${t.id} order by g.id desc limit 30`;
    // Temas parecidos (para juntar).
    const similar = await db()`
      select o.id, o.title, o.kind, o.status, o.occurrences,
             1 - (o.centroid operator(extensions.<=>) (select centroid from public.gap_topics where id = ${t.id})) as similarity
      from public.gap_topics o
      where o.agent_id = ${t.agent_id} and o.id <> ${t.id} and o.centroid is not null
      order by o.centroid operator(extensions.<=>) (select centroid from public.gap_topics where id = ${t.id}) limit 5`;
    return { topic, examples, similar };
  });

  app.patch("/v1/agents/:id/gap-topics/:tid", async (req) => {
    const t = await loadTopic(req);
    const body = parseBody(
      z.object({ status: z.enum(["open", "ignored"]).optional(), title: z.string().trim().min(1).max(300).optional(), by: z.string().max(200).optional() }),
      req.body,
    );
    await db()`
      update public.gap_topics set
        status = coalesce(${body.status ?? null}, status),
        title = coalesce(${body.title ?? null}, title),
        title_source = case when ${body.title ?? null}::text is null then title_source else 'person' end,
        -- Reabrir um tema treinado volta a contar do zero.
        trained_at = case when ${body.status ?? null}::text = 'open' then null else trained_at end,
        after_trained = case when ${body.status ?? null}::text = 'open' then 0 else after_trained end,
        updated_at = now()
      where id = ${t.id}`;
    return { ok: true };
  });

  app.post("/v1/agents/:id/gap-topics/:tid/suggest", async (req) => {
    const t = await loadTopic(req);
    try {
      return { suggestion: await suggestForTopic(t.id) };
    } catch (e) {
      throw llmError(e, "A MAVI não conseguiu sugerir a resposta");
    }
  });

  app.post("/v1/agents/:id/gap-topics/:tid/apply", async (req, reply) => {
    const t = await loadTopic(req);
    const body = parseBody(
      z.object({ question: z.string().trim().min(3).max(300), answer: z.string().trim().min(3).max(8000), by: z.string().max(200).optional() }),
      req.body,
    );
    if (/\[PREENCHER/i.test(body.answer)) throw new HttpError(400, "Complete os trechos [PREENCHER: …] da resposta antes de incluir no treinamento.");
    const itemId = await applyToTraining(t.id, { question: body.question, answer: body.answer, by: body.by ?? req.client!.name });
    return reply.code(201).send({ knowledge_item_id: itemId });
  });

  app.post("/v1/agents/:id/gap-topics/:tid/merge", async (req) => {
    const t = await loadTopic(req);
    const body = parseBody(z.object({ into: z.string().uuid() }), req.body);
    const [into] = await db()<{ id: string }[]>`select id from public.gap_topics where id = ${body.into} and agent_id = ${t.agent_id}`;
    if (!into || into.id === t.id) throw new HttpError(400, "Só dá para juntar com outro tema do mesmo agente.");
    await mergeTopics(t.id, into.id);
    return { ok: true, into: into.id };
  });

  // ---------------------------------------------------------------- relatório
  app.get("/v1/agents/:id/report", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { from?: string; to?: string };
    const p = period(q);
    const report = await buildReport(a.id, p.cur.from, p.cur.to);
    const [reading] = await db()`
      select reading, model, created_by, created_at from public.agent_readings
      where agent_id = ${a.id} and period_from = ${p.cur.from} and period_to = ${p.cur.to}`;
    return { report, reading: reading ?? null };
  });

  /** Escreve (ou reescreve) a Leitura da MAVI do período. */
  app.post("/v1/agents/:id/reading", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(z.object({ from: z.string(), to: z.string(), by: z.string().max(200).optional() }), req.body);
    const p = period(body);
    const report = await buildReport(a.id, p.cur.from, p.cur.to);
    if (!report.metrics.conversations && !report.insights.analyzed) throw new HttpError(400, "Sem conversas no período para a MAVI ler.");
    let r;
    try {
      r = await generateReading(a.id, report);
    } catch (e) {
      throw llmError(e, "A MAVI não conseguiu escrever a leitura");
    }
    const [row] = await db()`
      insert into public.agent_readings (agent_id, period_from, period_to, reading, model, cost_usd, created_by)
      values (${a.id}, ${p.cur.from}, ${p.cur.to}, ${db().json(r.reading as never)}, ${r.model}, ${r.cost}, ${body.by ?? req.client!.name})
      on conflict (agent_id, period_from, period_to) do update set
        reading = excluded.reading, model = excluded.model, cost_usd = public.agent_readings.cost_usd + excluded.cost_usd,
        created_by = excluded.created_by, created_at = now()
      returning reading, model, created_by, created_at`;
    return { reading: row };
  });

  /** As conversas lidas do período, com filtro (para abrir a partir de um número do relatório). */
  app.get("/v1/agents/:id/insights/conversations", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { from?: string; to?: string; outcome?: string; sentiment?: string; objection?: string; reason?: string; issue?: string; topic?: string; limit?: string; offset?: string };
    const { cur } = period(q);
    const outcome = (OUTCOMES as readonly string[]).includes(String(q.outcome)) ? String(q.outcome) : null;
    const sentiment = ["positive", "neutral", "negative"].includes(String(q.sentiment)) ? String(q.sentiment) : null;
    const objection = q.objection ? String(q.objection).slice(0, 60) : null;
    const topic = q.topic ? String(q.topic).slice(0, 60) : null;
    const reason = q.reason ? String(q.reason).slice(0, 60) : null;
    const issue = q.issue ? String(q.issue).slice(0, 40) : null;
    const limit = Math.min(Number(q.limit) || 50, 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const rows = await db()`
      select i.conversation_id, c.external_id, c.contact_name, c.phone, i.intent, i.outcome, i.outcome_reason, i.reason_label, i.sentiment,
             i.objections, i.topics, i.agent_issues, i.summary, i.lead_messages, i.activity_at, count(*) over ()::int as total
      from public.conversation_insights i join public.conversations c on c.id = i.conversation_id
      where i.agent_id = ${a.id}
        and i.activity_at >= (${cur.from}::date)::timestamp at time zone ${TZ}
        and i.activity_at < ((${cur.to}::date) + 1)::timestamp at time zone ${TZ}
        and (${outcome}::text is null or i.outcome = ${outcome})
        and (${sentiment}::text is null or i.sentiment = ${sentiment})
        and (${objection}::text is null or ${objection} = any (i.objections))
        and (${topic}::text is null or ${topic} = any (i.topics))
        and (${reason}::text is null or i.reason_label = ${reason})
        and (${issue}::text is null or exists (select 1 from jsonb_array_elements(i.agent_issues) x where x->>'type' = ${issue}))
      order by i.activity_at desc limit ${limit} offset ${offset}`;
    return { conversations: rows, total: (rows[0] as { total?: number } | undefined)?.total ?? 0 };
  });

  /** Uma conversa com a leitura e as lacunas que ela teve. */
  app.get("/v1/agents/:id/conversations/:cid/insight", async (req) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const a = await loadAgent(req, id);
    assertUuid(cid, "Conversa");
    const [conversation] = await db()`
      select id, external_id, phone, contact_name, facts, summary, last_inbound_at, last_reply_at, created_at
      from public.conversations where id = ${cid} and agent_id = ${a.id}`;
    if (!conversation) throw notFound("Conversa");
    const [insight] = await db()`select * from public.conversation_insights where conversation_id = ${cid}`;
    const gaps = await db()`
      select g.id, g.kind, g.text, g.created_at, g.topic_id, t.title as topic_title, t.status as topic_status
      from public.gaps g left join public.gap_topics t on t.id = g.topic_id
      where g.conversation_id = ${cid} order by g.id`;
    return { conversation, insight: insight ?? null, gaps };
  });
}
