import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { HttpError, parseBody } from "../http.js";
import { loadAgent } from "./agents.js";
import { insertItem, NewItem } from "./knowledge.js";

/**
 * A base em teste de um treino automático (MAVI Tasks): itens novos ou
 * corrigidos que só as conversas do treino veem, e itens escondidos só nelas.
 * No fim, o que a pessoa aprovou vira base de verdade (promote); o resto sai
 * (discard). As conversas reais nunca veem nada disto (kb_search).
 */

const TrainingId = z.string().trim().min(1).max(64).regex(/^[\w-]+$/);
const Ids = z.array(z.string().uuid()).max(500).default([]);

function params(req: { params: unknown }) {
  const p = req.params as { id: string; tid: string };
  const tid = TrainingId.safeParse(p.tid);
  if (!tid.success) throw new HttpError(400, "Treino inválido.");
  return { id: p.id, tid: tid.data };
}

export async function trainingRoutes(app: FastifyInstance) {
  app.get("/v1/agents/:id/trainings/:tid/knowledge", async (req) => {
    const { id, tid } = params(req);
    const a = await loadAgent(req, id);
    const sql = db();
    const staged = await sql`
      select id, kind, title, left(body, 400) as body_preview, data, status, error, chunk_count, created_at
      from public.knowledge_items where agent_id = ${a.id} and training_id = ${tid} and deleted_at is null order by created_at`;
    const hidden = await sql`
      select i.id, i.kind, i.title, left(i.body, 400) as body_preview, i.data from public.knowledge_hides h
      join public.knowledge_items i on i.id = h.item_id where h.training_id = ${tid} and h.agent_id = ${a.id} order by h.created_at`;
    return { staged, hidden, pending: staged.filter((x) => x.status === "pending" || x.status === "processing").length };
  });

  /** Itens em teste (a mesma validação da base). */
  app.post("/v1/agents/:id/trainings/:tid/knowledge", async (req, reply) => {
    const { id, tid } = params(req);
    const a = await loadAgent(req, id);
    const body = parseBody(z.object({ items: z.array(z.unknown()).min(1).max(100) }), req.body);
    const errors: { index: number; error: string }[] = [];
    const ids: (string | null)[] = [];
    for (const [i, raw] of body.items.entries()) {
      const r = NewItem.safeParse(raw);
      if (!r.success) {
        errors.push({ index: i, error: r.error.issues.map((x) => x.message).join("; ") });
        ids.push(null);
        continue;
      }
      ids.push(await insertItem(a.id, r.data, req.client!.name, tid));
    }
    return reply.code(201).send({ ids, errors });
  });

  /** Esconder itens da base nas conversas do treino (tirar ou corrigir: o corrigido entra como item em teste). */
  app.post("/v1/agents/:id/trainings/:tid/knowledge/hide", async (req) => {
    const { id, tid } = params(req);
    const a = await loadAgent(req, id);
    const body = parseBody(z.object({ item_ids: Ids }), req.body);
    const rows = await db()`
      insert into public.knowledge_hides (training_id, item_id, agent_id)
      select ${tid}, i.id, i.agent_id from public.knowledge_items i
      where i.id = any(${body.item_ids}::uuid[]) and i.agent_id = ${a.id} and i.training_id is null and i.deleted_at is null
      on conflict do nothing returning item_id`;
    return { hidden: rows.length };
  });

  /** Desfazer parte do teste (a rodada que não melhorou): tira itens em teste e volta a mostrar escondidos. */
  app.post("/v1/agents/:id/trainings/:tid/knowledge/revert", async (req) => {
    const { id, tid } = params(req);
    const a = await loadAgent(req, id);
    const body = parseBody(z.object({ item_ids: Ids, unhide: Ids }), req.body);
    const sql = db();
    const removed = await sql`
      delete from public.knowledge_items where agent_id = ${a.id} and training_id = ${tid} and id = any(${body.item_ids}::uuid[]) returning id`;
    const shown = await sql`
      delete from public.knowledge_hides where training_id = ${tid} and agent_id = ${a.id} and item_id = any(${body.unhide}::uuid[]) returning item_id`;
    return { removed: removed.length, unhidden: shown.length };
  });

  /** O que a pessoa aprovou vira base de verdade; o resto do teste sai. */
  app.post("/v1/agents/:id/trainings/:tid/promote", async (req) => {
    const { id, tid } = params(req);
    const a = await loadAgent(req, id);
    const body = parseBody(z.object({ item_ids: Ids, hide_ids: Ids, updated_by: z.string().max(200).optional() }), req.body);
    return db().begin(async (sql) => {
      const promoted = await sql`
        update public.knowledge_items set training_id = null, updated_at = now()
        where agent_id = ${a.id} and training_id = ${tid} and id = any(${body.item_ids}::uuid[]) returning id`;
      const removed = await sql`
        update public.knowledge_items set deleted_at = now(), updated_at = now()
        where agent_id = ${a.id} and training_id is null and deleted_at is null
          and id in (select h.item_id from public.knowledge_hides h where h.training_id = ${tid} and h.item_id = any(${body.hide_ids}::uuid[]))
        returning id`;
      await sql`delete from public.knowledge_items where agent_id = ${a.id} and training_id = ${tid}`;
      await sql`delete from public.knowledge_hides where training_id = ${tid} and agent_id = ${a.id}`;
      return { promoted: promoted.length, removed: removed.length };
    });
  });

  app.post("/v1/agents/:id/trainings/:tid/discard", async (req) => {
    const { id, tid } = params(req);
    const a = await loadAgent(req, id);
    const sql = db();
    const items = await sql`delete from public.knowledge_items where agent_id = ${a.id} and training_id = ${tid} returning id`;
    const hides = await sql`delete from public.knowledge_hides where training_id = ${tid} and agent_id = ${a.id} returning item_id`;
    return { removed: items.length, unhidden: hides.length };
  });
}
