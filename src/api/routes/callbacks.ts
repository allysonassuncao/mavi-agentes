import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { scheduleCallback } from "../../queue.js";
import { manualCreated, maxDaysFor, validManualDue, type CallbackRow } from "../../runtime/callbacks.js";
import { publishedSpec } from "../../runtime/turn.js";
import { assertUuid, HttpError, notFound, parseBody } from "../http.js";
import { startFollowup } from "../../runtime/followup-track.js";
import { loadAgent } from "./agents.js";

/**
 * Retornos combinados para a aba Retornos do construtor: os marcados (do mais
 * próximo ao mais distante), os que já passaram e os cancelados, com o que o
 * lead pediu e o que aconteceu. A pessoa remarca, cancela, chama agora ou
 * marca um à mão (as ações de "ao registrar" valem também).
 */

const cols = () => db()`
  k.id, k.conversation_id, c.external_id, c.contact_name, c.phone, k.due_at, k.status, k.agreed, k.source, k.request, k.topic, k.seq,
  k.created_by, k.created_at, k.sent_at, k.outcome, k.actions, k.replied_at, k.no_reply_at, k.canceled_reason, k.canceled_by, k.history, k.updated_at`;

const By = z.object({ by: z.string().trim().max(200).optional() });

async function loadCallback(agentId: string, id: string): Promise<CallbackRow> {
  assertUuid(id, "Retorno");
  const [cb] = await db()<CallbackRow[]>`select * from public.agent_callbacks where id = ${id} and agent_id = ${agentId} and not simulation`;
  if (!cb) throw notFound("Retorno");
  return cb;
}

const notScheduled = () => new HttpError(409, "Este retorno não está mais marcado (já saiu ou foi cancelado). Atualize a lista.");

export async function callbackRoutes(app: FastifyInstance) {
  app.get("/v1/agents/:id/callbacks", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { view?: string; q?: string; conversation?: string; before?: string; limit?: string };
    const view = q.view === "past" || q.view === "canceled" ? q.view : "scheduled";
    const limit = Math.min(Math.max(Number(q.limit) || 50, 10), 200);
    const term = String(q.q ?? "").trim().slice(0, 80);
    const digits = term.replace(/\D/g, "");
    const like = term ? `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%` : null;
    const conversation = q.conversation && /^[0-9a-f-]{36}$/i.test(q.conversation) ? q.conversation : null;
    // Página por (due_at, id) do último da página anterior: "<iso>_<id>".
    const [beforeAt, beforeId] = String(q.before ?? "").split("_");
    const before = beforeAt && !Number.isNaN(Date.parse(beforeAt)) && beforeId && /^[0-9a-f-]{36}$/i.test(beforeId) ? { at: new Date(beforeAt), id: beforeId } : null;
    const sql = db();
    const statuses = view === "scheduled" ? ["scheduled", "sending"] : view === "canceled" ? ["canceled"] : ["done", "skipped", "failed"];
    const rows = await sql`
      select ${cols()} from public.agent_callbacks k join public.conversations c on c.id = k.conversation_id
      where k.agent_id = ${a.id} and not k.simulation and k.status = any (${statuses}::text[])
        and (${conversation}::uuid is null or k.conversation_id = ${conversation}::uuid)
        and (${like}::text is null or c.contact_name ilike ${like} or (${digits} <> '' and regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') like ${`%${digits}%`}))
        and (${before?.at ?? null}::timestamptz is null or ${view === "scheduled"} or (k.due_at, k.id) < (${before?.at ?? null}::timestamptz, ${before?.id ?? null}::uuid))
      order by ${view === "scheduled" ? sql`k.due_at asc, k.id asc` : sql`k.due_at desc, k.id desc`}
      limit ${view === "scheduled" ? 200 : limit + 1}`;
    const page = view === "scheduled" ? rows : rows.slice(0, limit);
    const [counts] = await sql`
      select count(*) filter (where status in ('scheduled', 'sending'))::int as scheduled,
             count(*) filter (where status = 'scheduled' and due_at < now())::int as overdue,
             count(*) filter (where status = 'scheduled' and (due_at at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date)::int as today,
             count(*) filter (where status = 'done' and sent_at > now() - interval '7 days')::int as sent_7d,
             count(*) filter (where status = 'done' and replied_at is not null and sent_at > now() - interval '7 days')::int as replied_7d,
             count(*) filter (where no_reply_at > now() - interval '7 days')::int as no_reply_7d,
             count(*) filter (where status in ('skipped', 'failed') and updated_at > now() - interval '7 days')::int as problems_7d,
             count(*) filter (where status = 'canceled' and updated_at > now() - interval '7 days')::int as canceled_7d
      from public.agent_callbacks where agent_id = ${a.id} and not simulation`;
    return {
      view,
      callbacks: page,
      next: view !== "scheduled" && rows.length > limit ? `${(page[page.length - 1]!.due_at as Date).toISOString()}_${page[page.length - 1]!.id}` : null,
      counts,
    };
  });

  /** Marca um retorno à mão numa conversa (sem o lead ter pedido). */
  app.post("/v1/agents/:id/callbacks", async (req, reply) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(
      By.extend({
        conversation_id: z.string().uuid(),
        due_at: z.string().datetime({ offset: true }),
        topic: z.string().trim().max(500).default(""),
        request: z.string().trim().max(500).default(""),
      }),
      req.body,
    );
    const due = new Date(body.due_at);
    const invalid = validManualDue(due, await maxDaysFor(a.id));
    if (invalid) throw new HttpError(400, invalid);
    const sql = db();
    const [conv] = await sql<{ id: string }[]>`select id from public.conversations where id = ${body.conversation_id} and agent_id = ${a.id} and not simulation`;
    if (!conv) throw notFound("Conversa");
    const by = body.by ?? req.client!.name;
    const [cb] = await sql<CallbackRow[]>`
      insert into public.agent_callbacks (agent_id, conversation_id, due_at, agreed, source, request, topic, seq, created_by)
      values (${a.id}, ${conv.id}, ${due}, 'confirmed', 'manual', ${body.request}, ${body.topic}, 0, ${by})
      on conflict do nothing returning *`;
    if (!cb) throw new HttpError(409, "Esta conversa já tem um retorno marcado: remarque o que está lá.");
    await sql`insert into public.messages (conversation_id, role, content) values (${conv.id}, 'note', ${`Retorno marcado por ${by}${body.topic ? `: ${body.topic}` : ""}.`})`;
    const done = await manualCreated(cb).catch((e) => [`ações falharam: ${String(e).slice(0, 160)}`]);
    reply.code(201);
    return { callback: cb, actions: done };
  });

  /** Remarca (e/ou troca o que retomar). */
  app.patch("/v1/agents/:id/callbacks/:cbid", async (req) => {
    const { id, cbid } = req.params as { id: string; cbid: string };
    const a = await loadAgent(req, id);
    const cb = await loadCallback(a.id, cbid);
    const body = parseBody(By.extend({ due_at: z.string().datetime({ offset: true }).optional(), topic: z.string().trim().max(500).optional() }), req.body);
    const due = body.due_at ? new Date(body.due_at) : cb.due_at;
    if (body.due_at) {
      const invalid = validManualDue(due, await maxDaysFor(a.id));
      if (invalid) throw new HttpError(400, invalid);
    }
    const by = body.by ?? req.client!.name;
    const moved = due.getTime() !== cb.due_at.getTime();
    const sql = db();
    const [row] = await sql`
      update public.agent_callbacks set due_at = ${due}, topic = ${body.topic ?? cb.topic},
        history = case when ${moved} then history || ${sql.json([{ at: new Date().toISOString(), from: cb.due_at.toISOString(), to: due.toISOString(), by }] as never)} else history end,
        updated_at = now()
      where id = ${cb.id} and status = 'scheduled' returning id`;
    if (!row) throw notScheduled();
    return { ok: true };
  });

  app.post("/v1/agents/:id/callbacks/:cbid/cancel", async (req) => {
    const { id, cbid } = req.params as { id: string; cbid: string };
    const a = await loadAgent(req, id);
    const cb = await loadCallback(a.id, cbid);
    const body = parseBody(By.extend({ reason: z.string().trim().max(300).optional() }), req.body);
    const by = body.by ?? req.client!.name;
    const [row] = await db()`
      update public.agent_callbacks set status = 'canceled', canceled_reason = ${body.reason || "cancelado na aba Retornos"}, canceled_by = ${by}, updated_at = now()
      where id = ${cb.id} and status = 'scheduled' returning id`;
    if (!row) throw notScheduled();
    await db()`insert into public.messages (conversation_id, role, content) values (${cb.conversation_id}, 'note', ${`Retorno combinado cancelado por ${by}.`})`;
    // A régua estava esperando o retorno: volta a contar a partir de agora (se o lead não estiver esperando resposta).
    const spec = (await publishedSpec(a.id).catch(() => null))?.spec;
    const fu = spec?.followup;
    if (spec?.callbacks?.followup.during === "pause" && spec.callbacks.followup.after === "restart" && fu?.enabled && fu.steps.length) {
      const [conv] = await db()<{ id: string; simulation: boolean; external_id: string }[]>`
        select c.id, c.simulation, c.external_id from public.conversations c
        where c.id = ${cb.conversation_id} and c.followup_state = 'idle'
          and (select role from public.messages m where m.conversation_id = c.id and m.role in ('user', 'assistant') order by m.id desc limit 1) = 'assistant'`;
      if (conv) await startFollowup(fu, conv).catch(() => {});
    }
    return { ok: true };
  });

  /** Chama agora: o retorno sai já (o agente retoma a conversa e as ações de "na hora" valem). */
  app.post("/v1/agents/:id/callbacks/:cbid/now", async (req) => {
    const { id, cbid } = req.params as { id: string; cbid: string };
    const a = await loadAgent(req, id);
    const cb = await loadCallback(a.id, cbid);
    const body = parseBody(By, req.body);
    const by = body.by ?? req.client!.name;
    // Como a varredura: só com o agente ativo e a caixa ligada.
    const [live] = await db()`
      select 1 from public.conversations c join public.bindings b on b.id = c.binding_id and b.enabled and b.removed_at is null
      where c.id = ${cb.conversation_id} and ${a.status} = 'active'`;
    if (!live) throw new HttpError(409, "O agente está pausado ou a caixa desta conversa está desligada: o retorno não sai agora.");
    const now = new Date();
    const sql = db();
    const [row] = await sql`
      update public.agent_callbacks set due_at = ${now},
        history = history || ${sql.json([{ at: now.toISOString(), from: cb.due_at.toISOString(), to: now.toISOString(), by, now: true }] as never)},
        updated_at = now()
      where id = ${cb.id} and status = 'scheduled' returning id`;
    if (!row) throw notScheduled();
    await scheduleCallback({ conversationId: cb.conversation_id, callbackId: cb.id }, String(now.getTime()));
    return { ok: true };
  });
}
