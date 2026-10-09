import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../../db.js";
import { kindOf } from "../../knowledge/extract.js";
import { searchKnowledge } from "../../knowledge/search.js";
import { putObject, removeObjects } from "../../knowledge/storage.js";
import { scheduleIngest } from "../../queue.js";
import { canCompany } from "../auth.js";
import { assertUuid, HttpError, notFound, parseBody } from "../http.js";
import { loadAgent } from "./agents.js";

const Kind = z.enum(["faq", "product", "document", "media", "example", "text"]);

/** Item enviado como JSON (texto, FAQ, produto, mídia por link, página por URL). */
const NewItem = z
  .object({
    kind: Kind,
    title: z.string().trim().max(300).default(""),
    body: z.string().max(200_000).default(""),
    data: z.record(z.string(), z.unknown()).default({}),
    /** document: página/arquivo para baixar. media: o link da mídia vai em data.url. */
    url: z.string().url().max(2000).optional(),
    created_by: z.string().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, message: string) => ok || ctx.addIssue({ code: "custom", message });
    if (v.kind === "faq") need(!!String(v.data.question ?? v.title).trim() && !!String(v.data.answer ?? v.body).trim(), "FAQ precisa de pergunta e resposta.");
    if (v.kind === "product") need(!!String(v.data.name ?? v.title).trim(), "Produto precisa de nome.");
    if (v.kind === "media") need(/^https:\/\//.test(String(v.data.url ?? "")) && !!String(v.data.description ?? v.body).trim(), "Mídia precisa de data.url (https) e descrição.");
    if (v.kind === "document") need(!!v.url || !!v.body.trim(), "Documento precisa de url ou texto (para arquivo, use /knowledge/upload).");
    if (v.kind === "text" || v.kind === "example") need(!!v.body.trim(), "Texto vazio.");
  });

const ITEM_COLUMNS = "id, kind, title, left(body, 400) as body_preview, length(body) as body_length, data, source, status, error, chunk_count, created_by, created_at, updated_at";

async function loadItem(req: FastifyRequest, id: string) {
  assertUuid(id, "Item");
  const [it] = await db()<{ id: string; agent_id: string; company_id: string; source: { storage_path?: string } }[]>`
    select i.id, i.agent_id, a.company_id, i.source from public.knowledge_items i
    join public.agents a on a.id = i.agent_id
    where i.id = ${id} and i.deleted_at is null and a.archived_at is null`;
  if (!it || !canCompany(req, it.company_id)) throw notFound("Item");
  return it;
}

async function insertItem(agentId: string, v: z.infer<typeof NewItem>, createdBy: string) {
  const source = v.url ? { type: "url", url: v.url } : { type: "text" };
  const [row] = await db()<{ id: string }[]>`
    insert into public.knowledge_items (agent_id, kind, title, body, data, source, created_by)
    values (${agentId}, ${v.kind}, ${v.title}, ${v.body}, ${db().json(v.data as never)}, ${db().json(source as never)}, ${v.created_by ?? createdBy})
    returning id`;
  await scheduleIngest(row!.id);
  return row!.id;
}

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get("/v1/agents/:id/knowledge", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { kind?: string; limit?: string; offset?: string };
    const kind = q.kind && Kind.safeParse(q.kind).success ? q.kind : null;
    const limit = Math.min(Number(q.limit) || 200, 1000);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const items = await db().unsafe(
      `select ${ITEM_COLUMNS} from public.knowledge_items
       where agent_id = $1 and deleted_at is null and ($2::text is null or kind = $2)
       order by kind, title, created_at limit $3 offset $4`,
      [a.id, kind, limit, offset],
    );
    const [totals] = await db()`
      select count(*)::int as total,
             count(*) filter (where status = 'ready')::int as ready,
             count(*) filter (where status = 'error')::int as errors,
             count(*) filter (where status in ('pending', 'processing'))::int as processing,
             coalesce(sum(chunk_count), 0)::int as chunks
      from public.knowledge_items where agent_id = ${a.id} and deleted_at is null`;
    return { items, totals };
  });

  app.post("/v1/agents/:id/knowledge", async (req, reply) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const v = parseBody(NewItem, req.body);
    const id = await insertItem(a.id, v, req.client!.name);
    return reply.code(201).send({ id });
  });

  /** Importação em lote (FAQ e produtos vindos de planilha, por exemplo). */
  app.post("/v1/agents/:id/knowledge/bulk", async (req, reply) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(z.object({ items: z.array(z.unknown()).min(1).max(500) }), req.body);
    const errors: { index: number; error: string }[] = [];
    const ids: string[] = [];
    for (let i = 0; i < body.items.length; i++) {
      const r = NewItem.safeParse(body.items[i]);
      if (!r.success) {
        errors.push({ index: i, error: r.error.issues.map((x) => x.message).join("; ") });
        continue;
      }
      ids.push(await insertItem(a.id, r.data, req.client!.name));
    }
    return reply.code(201).send({ created: ids.length, ids, errors });
  });

  /** Arquivo (multipart): campo "file" + kind (document|media), title, description. */
  app.post("/v1/agents/:id/knowledge/upload", async (req, reply) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const file = await req.file({ limits: { fileSize: 50 * 1024 * 1024 } });
    if (!file) throw new HttpError(400, "Envie o arquivo no campo 'file'.");
    const field = (name: string) => {
      const f = file.fields[name] as { value?: unknown } | undefined;
      return typeof f?.value === "string" ? f.value.trim() : "";
    };
    const kind = field("kind") || "document";
    if (kind !== "document" && kind !== "media") throw new HttpError(400, "kind deve ser document ou media.");
    const bytes = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, "Arquivo maior que 50 MB.");
    const mime = file.mimetype || "application/octet-stream";
    if (kind === "document" && !kindOf(mime, file.filename)) throw new HttpError(415, "Tipo de documento não suportado (PDF, DOCX, TXT, MD, CSV, HTML).");
    const description = field("description");
    if (kind === "media" && !description) throw new HttpError(400, "Mídia precisa de descrição (é por ela que o agente encontra a mídia).");

    const id = randomUUID();
    const safeName = file.filename.replace(/[^\w.\-]+/g, "_").slice(-120) || "arquivo";
    const path = `${a.id}/${id}/${safeName}`;
    await putObject(path, bytes, mime);
    const source = { type: "upload", filename: file.filename, mime, size: bytes.length, storage_path: path };
    const data =
      kind === "media"
        ? { storage_path: path, mime, media_kind: mime.split("/")[0], description }
        : {};
    await db()`
      insert into public.knowledge_items (id, agent_id, kind, title, body, data, source, created_by)
      values (${id}, ${a.id}, ${kind}, ${field("title") || file.filename}, ${kind === "media" ? description : ""},
              ${db().json(data as never)}, ${db().json(source as never)}, ${field("created_by") || req.client!.name})`;
    await scheduleIngest(id);
    return reply.code(201).send({ id });
  });

  app.get("/v1/knowledge/:itemId", async (req) => {
    const it = await loadItem(req, (req.params as { itemId: string }).itemId);
    const [item] = await db()`select * from public.knowledge_items where id = ${it.id}`;
    const chunks = await db()`
      select id, ord, title, content, context, meta from public.knowledge_chunks where item_id = ${it.id} order by ord limit 500`;
    return { item, chunks };
  });

  app.put("/v1/knowledge/:itemId", async (req) => {
    const it = await loadItem(req, (req.params as { itemId: string }).itemId);
    const body = parseBody(
      z.object({ title: z.string().trim().max(300).optional(), body: z.string().max(200_000).optional(), data: z.record(z.string(), z.unknown()).optional() }),
      req.body,
    );
    await db()`
      update public.knowledge_items set
        title = coalesce(${body.title ?? null}, title),
        body = coalesce(${body.body ?? null}, body),
        data = coalesce(${body.data ? db().json(body.data as never) : null}::jsonb, data),
        status = 'pending', updated_at = now()
      where id = ${it.id}`;
    await scheduleIngest(it.id);
    return { ok: true };
  });

  app.post("/v1/knowledge/:itemId/reprocess", async (req) => {
    const it = await loadItem(req, (req.params as { itemId: string }).itemId);
    await db()`update public.knowledge_items set status = 'pending', updated_at = now() where id = ${it.id}`;
    await scheduleIngest(it.id);
    return { ok: true };
  });

  app.delete("/v1/knowledge/:itemId", async (req) => {
    const it = await loadItem(req, (req.params as { itemId: string }).itemId);
    await db().begin(async (tx) => {
      await tx`update public.knowledge_items set deleted_at = now() where id = ${it.id}`;
      await tx`delete from public.knowledge_chunks where item_id = ${it.id}`;
    });
    if (it.source?.storage_path) await removeObjects([it.source.storage_path]).catch(() => {});
    return { ok: true };
  });

  /** Testar a busca como o agente faria (para o construtor). */
  app.post("/v1/agents/:id/knowledge/search", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(
      z.object({ query: z.string().trim().min(1).max(4000), k: z.number().int().min(1).max(30).default(8), kind: Kind.optional(), rerank: z.boolean().default(false) }),
      req.body,
    );
    const r = await searchKnowledge({ agentId: a.id, query: body.query, k: body.k, kinds: body.kind ? [body.kind] : null, rerank: body.rerank });
    return { results: r.results, cost_usd: r.usage.costUsd };
  });
}
