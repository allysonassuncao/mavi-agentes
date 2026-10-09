import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "../../db.js";
import { redis } from "../../redis.js";
import { MEDIA_TYPES } from "../../runtime/inbound.js";
import { runTurn } from "../../runtime/turn.js";
import { parseSpec, type AgentSpec } from "../../spec/agent.js";
import { assertUuid, HttpError, notFound, parseBody } from "../http.js";
import { canCompany } from "../auth.js";
import { loadAgent } from "./agents.js";

/** A trava por conversa do worker (worker.ts): uma coisa por vez na conversa. */
const convLockKey = (id: string) => `conv:lock:${id}`;
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

const Simulate = z.object({
  /** Chave da conversa de teste (ex.: "<pessoa>:<aba>"); a mesma chave continua a conversa. */
  session: z.string().trim().min(1).max(100),
  message: z.string().max(10_000).default(""),
  content_type: z.string().max(20).default("text"),
  media_url: z.string().url().max(2000).optional(),
  /** "draft" (padrão), "published" ou o número de uma versão. */
  use: z.union([z.literal("draft"), z.literal("published"), z.number().int().min(1)]).default("draft"),
  /** Começa a conversa do zero. */
  reset: z.boolean().default(false),
  contact_name: z.string().max(120).optional(),
  facts: z.record(z.string(), z.string()).optional(),
});

export async function simulateRoutes(app: FastifyInstance) {
  app.post("/v1/agents/:id/simulate", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(Simulate, req.body);
    if (!body.message.trim() && !body.media_url) throw new HttpError(400, "Mande uma mensagem ou uma mídia.");

    let spec: AgentSpec;
    let version: number | null = null;
    if (body.use === "draft") {
      const r = parseSpec(a.draft);
      if (!r.ok) throw new HttpError(422, "O rascunho tem campos inválidos.", r.errors);
      spec = r.spec;
    } else {
      version = body.use === "published" ? a.published_version : body.use;
      if (!version) throw new HttpError(400, "O agente ainda não tem versão publicada.");
      const [v] = await db()<{ spec: unknown }[]>`select spec from public.agent_versions where agent_id = ${a.id} and version = ${version}`;
      const r = parseSpec(v?.spec);
      if (!r.ok) throw notFound("Versão");
      spec = r.spec;
    }

    const sql = db();
    const [conv] = await sql<{ id: string }[]>`
      insert into public.conversations (agent_id, company_id, external_id, simulation, contact_name, phone)
      values (${a.id}, ${a.company_id}, ${body.session}, true, ${body.contact_name ?? "Lead de teste"}, '5500000000000')
      on conflict (agent_id, simulation, external_id) do update set contact_name = coalesce(${body.contact_name ?? null}, public.conversations.contact_name)
      returning id`;
    if (body.reset) {
      await sql`delete from public.messages where conversation_id = ${conv!.id}`;
      await sql`update public.conversations set summary = '', summary_upto = null, facts = '{}' where id = ${conv!.id}`;
    }
    if (body.facts) await sql`update public.conversations set facts = facts || ${sql.json(body.facts)} where id = ${conv!.id}`;
    const contentType = MEDIA_TYPES.has(body.content_type) && body.media_url ? body.content_type : "text";
    await sql`
      insert into public.messages (conversation_id, role, content, content_type, media)
      values (${conv!.id}, 'user', ${body.message}, ${contentType},
              ${body.media_url && contentType !== "text" ? sql.json({ url: body.media_url }) : null})`;

    const result = await runTurn({ conversationId: conv!.id, spec, agentVersion: version });
    const [turn] = result.turnId ? await sql`select * from public.turns where id = ${result.turnId}` : [];
    return { conversation_id: conv!.id, result, turn: turn ?? null };
  });

  app.get("/v1/agents/:id/simulations/:session/messages", async (req) => {
    const { id, session } = req.params as { id: string; session: string };
    const a = await loadAgent(req, id);
    const messages = await db()`
      select m.id, m.role, m.content, m.content_type, m.media, m.turn_id, m.created_at
      from public.messages m join public.conversations c on c.id = m.conversation_id
      where c.agent_id = ${a.id} and c.simulation and c.external_id = ${session}
      order by m.id limit 500`;
    return { messages };
  });

  // ---------------------------------------------------------------- rastros e uso
  app.get("/v1/agents/:id/turns", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { limit?: string; before?: string; simulation?: string; status?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const sim = q.simulation === "true" ? true : q.simulation === "false" ? false : null;
    const turns = await db()`
      select t.id, t.conversation_id, c.external_id, c.contact_name, c.phone, t.agent_version, t.simulation, t.status, t.model,
             t.rounds, t.tokens_in, t.tokens_out, t.tokens_cached, t.cost_usd, t.timings, t.error, t.created_at,
             t.output->'messages' as messages,
             coalesce((t.output->>'superseded')::boolean, false) as superseded,
             coalesce((t.output->>'interrupted')::boolean, false) as interrupted
      from public.turns t join public.conversations c on c.id = t.conversation_id
      where t.agent_id = ${a.id}
        and (${sim}::boolean is null or t.simulation = ${sim})
        and (${q.status ?? null}::text is null or t.status = ${q.status ?? null})
        and (${q.before ?? null}::timestamptz is null or t.created_at < ${q.before ?? null}::timestamptz)
      order by t.created_at desc limit ${limit}`;
    return { turns };
  });

  app.get("/v1/turns/:id", async (req) => {
    const { id } = req.params as { id: string };
    assertUuid(id, "Rastro");
    const [t] = await db()<{ conversation_id: string; agent_id: string; input_message_ids: string[]; company_id: string }[]>`
      select t.*, a.company_id from public.turns t join public.agents a on a.id = t.agent_id where t.id = ${id}`;
    if (!t || !canCompany(req, t.company_id)) throw notFound("Rastro");
    const messages = await db()`
      select id, role, content, content_type, media, turn_id, created_at from public.messages
      where conversation_id = ${t.conversation_id} and (id = any(${t.input_message_ids}::bigint[]) or turn_id = ${id})
      order by id`;
    return { turn: t, messages };
  });

  app.get("/v1/agents/:id/usage", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { from?: string; to?: string };
    const usage = await db()`
      select day, simulation, turns, errors, tokens_in, tokens_out, tokens_cached, cost_usd from public.usage_daily
      where agent_id = ${a.id}
        and day >= coalesce(${q.from ?? null}::date, current_date - 30)
        and day <= coalesce(${q.to ?? null}::date, current_date)
      order by day`;
    return { usage };
  });

  app.get("/v1/agents/:id/conversations", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { limit?: string; q?: string };
    // Busca por nome ou telefone (só os dígitos contam no telefone).
    const term = String(q.q ?? "").trim().slice(0, 80);
    const digits = term.replace(/\D/g, "");
    const like = term ? `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const conversations = await db()`
      select id, external_id, phone, contact_name, facts, summary, last_inbound_at, last_reply_at, created_at,
             memory_reset_at, memory_reset_by,
             (select count(*) from public.messages m where m.conversation_id = c.id and m.role in ('user', 'assistant'))::int as messages
      from public.conversations c where c.agent_id = ${a.id} and not c.simulation
        and (${like}::text is null or c.contact_name ilike ${like} or (${digits} <> '' and regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') like ${`%${digits}%`}))
      order by coalesce(c.last_inbound_at, c.created_at) desc limit ${Math.min(Number(q.limit) || 50, 200)}`;
    return { conversations };
  });

  /**
   * Os leads do agente (um por telefone; sem telefone, um por conversa), do
   * mais recente para o mais antigo, com a última mensagem, contagens, erros e
   * custo. Um lead pode ter mais de uma conversa (caixas diferentes): vêm as
   * conversas dele. Página por "before" (o last_at do último da página).
   */
  app.get("/v1/agents/:id/leads", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { limit?: string; q?: string; before?: string; errors?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
    const term = String(q.q ?? "").trim().slice(0, 80);
    const digits = term.replace(/\D/g, "");
    const like = term ? `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const before = q.before && !Number.isNaN(Date.parse(q.before)) ? new Date(q.before) : null;
    const onlyErrors = q.errors === "true";
    const sql = db();
    const conv = sql`
      select c.id, c.phone, c.contact_name, c.created_at,
             coalesce(nullif(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), ''), 'c:' || c.id::text) as lead_key,
             greatest(coalesce(c.last_inbound_at, c.created_at), coalesce(c.last_reply_at, c.created_at)) as last_at
      from public.conversations c
      where c.agent_id = ${a.id} and not c.simulation
        and (${like}::text is null or c.contact_name ilike ${like} or (${digits} <> '' and regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') like ${`%${digits}%`}))
        and (not ${onlyErrors} or exists (select 1 from public.turns t where t.conversation_id = c.id and t.status = 'error'))`;
    const rows = await sql`
      with conv as (${conv}),
      g as (
        select lead_key, max(last_at) as last_at, min(created_at) as first_at,
               array_agg(id order by last_at desc) as ids,
               jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'last_at', last_at) order by last_at desc) as conversations,
               (array_agg(contact_name order by last_at desc) filter (where contact_name is not null))[1] as contact_name,
               (array_agg(phone order by last_at desc) filter (where phone is not null))[1] as phone
        from conv group by lead_key
        having ${before}::timestamptz is null or max(last_at) < ${before}::timestamptz
        order by max(last_at) desc limit ${limit + 1}
      )
      select g.lead_key, g.last_at, g.first_at, g.conversations, g.contact_name, g.phone,
             lm.role as last_role, lm.content as last_content, coalesce(st.messages, 0) as messages,
             coalesce(t.replies, 0) as replies, coalesce(t.errors, 0) as errors, coalesce(t.cost_usd, 0) as cost_usd
      from g
      left join lateral (
        select m.role, m.content from public.messages m
        where m.conversation_id = any (g.ids) and m.role in ('user', 'assistant') order by m.id desc limit 1) lm on true
      left join lateral (
        select count(*)::int as messages from public.messages m where m.conversation_id = any (g.ids) and m.role in ('user', 'assistant')) st on true
      left join lateral (
        select count(*) filter (where t.status = 'done')::int as replies, count(*) filter (where t.status = 'error')::int as errors,
               sum(t.cost_usd) as cost_usd
        from public.turns t where t.conversation_id = any (g.ids)) t on true
      order by g.last_at desc`;
    const page = rows.slice(0, limit);
    const [total] = before ? [null] : await sql<{ n: number }[]>`with conv as (${conv}) select count(distinct lead_key)::int as n from conv`;
    return {
      leads: page.map((r) => ({ ...r, last_content: r.last_content ? String(r.last_content).slice(0, 300) : null })),
      next: rows.length > limit ? (page[page.length - 1]!.last_at as Date).toISOString() : null,
      total: total?.n ?? null,
    };
  });

  /**
   * Zera a memória do agente numa conversa: apaga as mensagens que ele guarda
   * (o histórico que relê a cada resposta), o resumo, os dados coletados do
   * contato e a leitura da MAVI; para o follow-up. Rastros e custos ficam
   * (controle financeiro); o histórico no MakeCRM não muda.
   */
  app.post("/v1/agents/:id/conversations/:cid/reset", async (req) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const a = await loadAgent(req, id);
    assertUuid(cid, "Conversa");
    const body = parseBody(z.object({ by: z.string().max(200).optional() }), req.body);
    const by = body.by ?? req.client!.name;
    const sql = db();
    const [c] = await sql<{ id: string }[]>`select id from public.conversations where id = ${cid} and agent_id = ${a.id} and not simulation`;
    if (!c) throw notFound("Conversa");
    // A mesma trava das respostas (worker.ts): não zera no meio de uma resposta.
    const token = randomUUID();
    if (!(await redis().set(convLockKey(cid), token, "PX", 60_000, "NX")))
      throw new HttpError(409, "O agente está respondendo este lead agora. Tente de novo em alguns segundos.");
    try {
      const removed = await sql.begin(async (tx) => {
        const [m] = await tx<{ n: number }[]>`
          with d as (delete from public.messages where conversation_id = ${cid} returning 1) select count(*)::int as n from d`;
        await tx`delete from public.conversation_insights where conversation_id = ${cid}`;
        await tx`
          update public.conversations set summary = '', summary_upto = null, facts = '{}',
            followup_step = 0, followup_state = 'idle', followup_next_at = null,
            memory_reset_at = now(), memory_reset_by = ${by}
          where id = ${cid}`;
        // Fica uma nota (o agente não lê notas) para quem abrir a conversa saber.
        await tx`insert into public.messages (conversation_id, role, content) values (${cid}, 'note', ${`Memória do agente zerada por ${by}.`})`;
        return m!.n;
      });
      // As travas de "já feito" (cenários, ações na oportunidade, mover): o lead recomeça do zero.
      for (const prefix of ["once", "sc", "da", "mv"]) {
        const keys: string[] = [];
        for await (const batch of redis().scanStream({ match: `${prefix}:${cid}:*`, count: 200 })) keys.push(...(batch as string[]));
        if (keys.length) await redis().del(...keys);
      }
      return { ok: true, removed_messages: removed };
    } finally {
      await redis().eval(RELEASE, 1, convLockKey(cid), token);
    }
  });

  app.get("/v1/agents/:id/conversations/:cid/messages", async (req) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const a = await loadAgent(req, id);
    assertUuid(cid, "Conversa");
    const [c] = await db()<{ id: string }[]>`select id from public.conversations where id = ${cid} and agent_id = ${a.id}`;
    if (!c) throw notFound("Conversa");
    const messages = await db()`
      select id, role, content, content_type, media, turn_id, created_at from public.messages
      where conversation_id = ${cid} order by id desc limit 300`;
    return { messages: messages.reverse() };
  });
}
