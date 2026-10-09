import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { HttpError, assertUuid, notFound, parseBody } from "../http.js";
import { loadAgent } from "./agents.js";

/**
 * Relatório de custos (cost_events): filtros por período, agentes, empresa,
 * caixas, conversa, tipo e simulação; agrupado por dia, agente, caixa,
 * conversa, tipo, grupo, modelo ou empresa; R$ pelas cotações de cada dia
 * (quem pede manda a PTAX). E a tabela de preços do WhatsApp Business API.
 */

const TZ = "America/Sao_Paulo";
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const SOURCES = [
  "reply", "followup", "media_audio", "media_image", "media_video", "media_document", "retrieval", "summary",
  "knowledge", "gaps", "insight", "reading", "waba_template", "test_persona", "test_lead", "test_judge",
] as const;

/** O grupo de cada tipo (para os gráficos). */
export const GROUP_SQL = `case
  when x.source in ('reply', 'followup') then 'ia'
  when x.source like 'media_%' then 'midias'
  when x.source in ('retrieval', 'knowledge') then 'conhecimento'
  when x.source in ('summary', 'gaps', 'insight', 'reading') then 'analises'
  when x.source = 'waba_template' then 'whatsapp'
  else 'testes' end`;

const GROUPS = {
  day: `to_char(x.day, 'YYYY-MM-DD')`,
  agent: `x.agent_id::text`,
  inbox: `x.inbox_id`,
  conversation: `x.conversation_id`,
  source: `x.source`,
  group: GROUP_SQL,
  model: `x.model`,
  company: `x.company_id`,
} as const;

const Query = z.object({
  from: z.string().regex(YMD),
  to: z.string().regex(YMD),
  agent_ids: z.array(z.string().uuid()).max(500).optional(),
  company_id: z.string().max(64).optional(),
  inbox_ids: z.array(z.string().max(64)).max(200).optional(),
  conversation_id: z.string().uuid().optional(),
  sources: z.array(z.enum(SOURCES)).max(SOURCES.length).optional(),
  /** exclude (padrão: só o real), include ou only (só testes e simulações). */
  simulation: z.enum(["exclude", "include", "only"]).default("exclude"),
  group: z.enum(Object.keys(GROUPS) as [keyof typeof GROUPS, ...(keyof typeof GROUPS)[]]).default("source"),
  /** R$ por US$ de cada dia ("AAAA-MM-DD" → cotação). */
  rates: z.record(z.string().regex(YMD), z.number().positive().max(100)).default({}),
  limit: z.number().int().min(1).max(1000).default(200),
});
export type CostQuery = z.infer<typeof Query>;

function scopeOf(req: FastifyRequest): string[] | null {
  return req.client?.company_scope ?? null;
}

/**
 * A consulta comum: "x" é cada gasto (por conversa) ou as somas do dia
 * (cost_daily, bem mais rápido); "rd" é a cotação de cada dia do período
 * (sem cotação no dia, a última antes dele; antes da primeira, a primeira).
 */
function base(q: CostQuery, scope: string[] | null) {
  const p: unknown[] = [];
  const add = (v: unknown) => `$${p.push(v)}`;
  const from = add(q.from);
  const to = add(q.to);
  const raw = q.group === "conversation" || !!q.conversation_id;
  const x = raw
    ? `(select (e.created_at at time zone '${TZ}')::date as day, e.agent_id, e.company_id, coalesce(e.inbox_id, '') as inbox_id, e.source,
              coalesce(e.model, '') as model, e.simulation, coalesce(e.conversation_id::text, '') as conversation_id, 1 as events,
              e.cost_usd, e.tokens_in, e.tokens_out, e.units
         from public.cost_events e
         where e.created_at >= (${from}::date)::timestamp at time zone '${TZ}' and e.created_at < ((${to}::date) + 1)::timestamp at time zone '${TZ}') x`
    : `(select d.day, d.agent_id, d.company_id, d.inbox_id, d.source, d.model, d.simulation, '' as conversation_id, d.events,
              d.cost_usd, d.tokens_in, d.tokens_out, d.units
         from public.cost_daily d where d.day between ${from}::date and ${to}::date) x`;
  const conds = ["true"];
  if (q.agent_ids) conds.push(`x.agent_id = any(${add(q.agent_ids)}::uuid[])`);
  if (q.company_id) conds.push(`x.company_id = ${add(q.company_id)}`);
  if (scope) conds.push(`x.company_id = any(${add(scope)}::text[])`);
  if (q.inbox_ids?.length) conds.push(`x.inbox_id = any(${add(q.inbox_ids)}::text[])`);
  if (q.conversation_id) conds.push(`x.conversation_id = ${add(q.conversation_id)}`);
  if (q.sources?.length) conds.push(`x.source = any(${add(q.sources)}::text[])`);
  if (q.simulation === "exclude") conds.push("not x.simulation");
  if (q.simulation === "only") conds.push("x.simulation");
  const rates = add(q.rates);
  const withRates = `with r as (select key::date as day, value::numeric as rate from jsonb_each_text(${rates}::jsonb)),
    rd as (select g::date as day, coalesce((select r.rate from r where r.day <= g::date order by r.day desc limit 1),
                                           (select r.rate from r order by r.day limit 1), 0) as rate
           from generate_series(${from}::date, ${to}::date, interval '1 day') g)`;
  return { p, from: `${withRates} select`, x: `${x} join rd on rd.day = x.day where ${conds.join(" and ")}`, raw };
}

const SUMS = (raw: boolean) => `
  coalesce(sum(x.events), 0)::int as events,
  coalesce(sum(x.cost_usd), 0)::float8 as cost_usd,
  coalesce(sum(x.cost_usd * rd.rate), 0)::float8 as cost_brl,
  coalesce(sum(x.tokens_in), 0)::bigint as tokens_in,
  coalesce(sum(x.tokens_out), 0)::bigint as tokens_out,
  coalesce(sum(x.units), 0)::float8 as units${raw ? ",\n  count(distinct nullif(x.conversation_id, ''))::int as conversations" : ""}`;

export async function costReport(q: CostQuery, scope: string[] | null) {
  const sql = db();
  const b = base(q, scope);
  const key = GROUPS[q.group];
  const [totals] = await sql.unsafe(`${b.from} ${SUMS(b.raw)} from ${b.x}`, b.p as never[]);
  const rows = await sql.unsafe(
    `${b.from} ${key} as key, ${SUMS(b.raw)} from ${b.x} group by 1 order by ${q.group === "day" ? "1" : "cost_usd desc"} limit ${q.limit}`,
    b.p as never[],
  );
  // Série diária por grupo (para o gráfico empilhado).
  const daily = await sql.unsafe(
    `${b.from} ${GROUPS.day} as day, ${GROUP_SQL} as "group", coalesce(sum(x.cost_usd), 0)::float8 as cost_usd,
       coalesce(sum(x.cost_usd * rd.rate), 0)::float8 as cost_brl
     from ${b.x} group by 1, 2 order by 1, 2`,
    b.p as never[],
  );
  // Mensagens no período (custo por mensagem do lead / por conversa), nos mesmos agentes e caixas.
  const mp: unknown[] = [q.from, q.to];
  const mconds = [
    `m.created_at >= ($1::date)::timestamp at time zone '${TZ}'`,
    `m.created_at < (($2::date) + 1)::timestamp at time zone '${TZ}'`,
    q.simulation === "only" ? "c.simulation" : q.simulation === "exclude" ? "not c.simulation" : "true",
  ];
  if (q.agent_ids) mconds.push(`c.agent_id = any($${mp.push(q.agent_ids)}::uuid[])`);
  if (q.company_id) mconds.push(`c.company_id = $${mp.push(q.company_id)}`);
  if (scope) mconds.push(`c.company_id = any($${mp.push(scope)}::text[])`);
  if (q.conversation_id) mconds.push(`c.id = $${mp.push(q.conversation_id)}::uuid`);
  if (q.inbox_ids?.length) mconds.push(`b.inbox_id = any($${mp.push(q.inbox_ids)}::text[])`);
  const [messages] = await sql.unsafe(
    `select count(*) filter (where m.role = 'user')::int as lead_messages,
            count(*) filter (where m.role = 'assistant')::int as agent_messages,
            count(distinct m.conversation_id) filter (where m.role = 'user')::int as conversations
     from public.messages m join public.conversations c on c.id = m.conversation_id
     left join public.bindings b on b.id = c.binding_id
     where ${mconds.join(" and ")}`,
    mp as never[],
  );
  // Nomes para as chaves (agente, caixa, conversa).
  let labels: Record<string, string> = {};
  const keys = rows.map((r) => String(r.key)).filter(Boolean);
  if (keys.length && q.group === "agent")
    labels = Object.fromEntries((await sql`select id::text, name from public.agents where id::text in ${sql(keys)}`).map((r) => [r.id, r.name]));
  if (keys.length && q.group === "inbox")
    labels = Object.fromEntries(
      (await sql`select distinct on (inbox_id) inbox_id, inbox_name from public.bindings where inbox_id in ${sql(keys)} order by inbox_id, created_at desc`).map(
        (r) => [r.inbox_id, r.inbox_name],
      ),
    );
  if (keys.length && q.group === "conversation")
    labels = Object.fromEntries(
      (await sql`select id::text, coalesce(contact_name, phone, 'Contato') as name from public.conversations where id::text in ${sql(keys)}`).map((r) => [r.id, r.name]),
    );
  return { totals, rows: rows.map((r) => ({ ...r, label: labels[String(r.key)] ?? null })), daily, messages };
}

const PriceRow = z.object({
  country: z.string().regex(/^(\*|[A-Z]{2})$/),
  category: z.enum(["marketing", "utility", "authentication"]),
  price_usd: z.number().min(0).max(10),
});

export async function costRoutes(app: FastifyInstance) {
  app.post("/v1/costs/query", async (req) => {
    const q = parseBody(Query, req.body);
    if (q.from > q.to) throw new HttpError(400, "O período começa depois de terminar.");
    return costReport(q, scopeOf(req));
  });

  /** Os gastos de uma conversa, um por linha (custo por mensagem na tela da conversa). */
  app.get("/v1/agents/:id/conversations/:cid/costs", async (req) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const a = await loadAgent(req, id);
    assertUuid(cid, "Conversa");
    const [c] = await db()`select id from public.conversations where id = ${cid} and agent_id = ${a.id}`;
    if (!c) throw notFound("Conversa");
    const events = await db()`
      select id, message_id, turn_id, source, provider, model, tokens_in, tokens_out, tokens_cached, units, cost_usd::float8 as cost_usd, meta, created_at
      from public.cost_events where conversation_id = ${cid} order by created_at, id limit 2000`;
    return { events };
  });

  /** Somas por dia × agente × caixa × tipo (para os Dashboards do MAVI Tasks). */
  app.post("/v1/costs/daily", async (req) => {
    const body = parseBody(z.object({ from: z.string().regex(YMD), to: z.string().regex(YMD) }), req.body);
    const scope = scopeOf(req);
    const rows = await db()`
      select to_char(d.day, 'YYYY-MM-DD') as day, d.agent_id, d.company_id, d.inbox_id, d.source, d.model, d.simulation,
             d.events, d.cost_usd::float8 as cost_usd, d.tokens_in, d.tokens_out, d.units::float8 as units
      from public.cost_daily d
      where d.day between ${body.from}::date and ${body.to}::date
        and (${scope}::text[] is null or d.company_id = any(${scope}::text[]))`;
    const agents = await db()`
      select id, name, company_id, external_ref from public.agents
      where id in (select distinct agent_id from public.cost_daily where day between ${body.from}::date and ${body.to}::date)`;
    const inboxes = await db()`select distinct on (inbox_id) inbox_id, inbox_name from public.bindings order by inbox_id, created_at desc`;
    return { rows, agents, inboxes };
  });

  // ---------------------------------------------------------------- preços do WhatsApp Business API
  app.get("/v1/settings/waba-prices", async () => {
    const prices = await db()`select country, category, price_usd::float8 as price_usd, updated_by, updated_at from public.waba_prices order by country = '*', country, category`;
    return { prices };
  });

  app.put("/v1/settings/waba-prices", async (req) => {
    if (scopeOf(req)) throw new HttpError(403, "Só a chave geral muda a tabela de preços.");
    const body = parseBody(z.object({ prices: z.array(PriceRow).min(1).max(300), updated_by: z.string().max(200).optional() }), req.body);
    const by = body.updated_by ?? req.client!.name;
    await db().begin(async (tx) => {
      await tx`delete from public.waba_prices`;
      for (const p of body.prices)
        await tx`insert into public.waba_prices (country, category, price_usd, updated_by) values (${p.country}, ${p.category}, ${p.price_usd}, ${by})
                 on conflict (country, category) do update set price_usd = excluded.price_usd, updated_by = excluded.updated_by, updated_at = now()`;
    });
    return { ok: true };
  });
}
