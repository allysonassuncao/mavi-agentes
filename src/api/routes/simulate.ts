import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { MEDIA_TYPES } from "../../runtime/inbound.js";
import { runTurn } from "../../runtime/turn.js";
import { parseSpec, type AgentSpec } from "../../spec/agent.js";
import { assertUuid, HttpError, notFound, parseBody } from "../http.js";
import { canCompany } from "../auth.js";
import { loadAgent } from "./agents.js";

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
             t.output->'messages' as messages
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
    const q = req.query as { limit?: string };
    const conversations = await db()`
      select id, external_id, phone, contact_name, facts, summary, last_inbound_at, last_reply_at, created_at
      from public.conversations where agent_id = ${a.id} and not simulation
      order by coalesce(last_inbound_at, created_at) desc limit ${Math.min(Number(q.limit) || 50, 200)}`;
    return { conversations };
  });

  app.get("/v1/conversations/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    assertUuid(id, "Conversa");
    const [c] = await db()<{ company_id: string }[]>`select company_id from public.conversations where id = ${id}`;
    if (!c || !canCompany(req, c.company_id)) throw notFound("Conversa");
    const messages = await db()`
      select id, role, content, content_type, media, turn_id, created_at from public.messages
      where conversation_id = ${id} order by id desc limit 300`;
    return { messages: messages.reverse() };
  });
}
