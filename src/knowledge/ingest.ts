import { config } from "../config.js";
import { db, toVector } from "../db.js";
import { addUsage, chat, embed, emptyUsage, type Usage } from "../llm/client.js";
import { recordCost } from "../costs/ledger.js";
import { log } from "../log.js";
import { fetchPublic } from "../net.js";
import { sha256 } from "../crypto.js";
import { chunkItem, type ChunkDraft, type KnowledgeKind } from "./chunk.js";
import { extractFile } from "./extract.js";
import { getObject } from "./storage.js";

/**
 * Processa um item da base: lê o arquivo/endereço (se houver), divide em
 * trechos, escreve a frase de contexto de cada trecho de documento, gera os
 * vetores e troca os trechos antigos pelos novos numa transação.
 */

const MAX_BODY = 2_000_000;
const MAX_DOWNLOAD = 30 * 1024 * 1024;

type ItemRow = {
  id: string;
  agent_id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  data: Record<string, unknown>;
  source: { type?: string; url?: string; storage_path?: string; mime?: string; filename?: string };
  content_hash: string | null;
};

export async function ingestItem(itemId: string): Promise<void> {
  const sql = db();
  const [item] = await sql<ItemRow[]>`
    update public.knowledge_items set status = 'processing', updated_at = now()
    where id = ${itemId} and deleted_at is null and status in ('pending', 'error', 'processing')
    returning id, agent_id, kind, title, body, data, source, content_hash`;
  if (!item) return;

  try {
    let body = item.body;
    const src = item.source ?? {};
    // Só documento tem texto para ler no arquivo; mídia (imagem, vídeo, áudio)
    // é encontrada pela descrição e enviada como arquivo.
    const readFile = item.kind === "document";
    if (readFile && src.type === "upload" && src.storage_path) {
      body = await extractFile(await getObject(src.storage_path), src.mime ?? "", src.filename ?? "");
    } else if (readFile && src.type === "url" && src.url) {
      const file = await fetchPublic(src.url, { maxBytes: MAX_DOWNLOAD, accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" });
      body = await extractFile(file.bytes, file.mime, new URL(file.finalUrl).pathname);
    }
    body = body.slice(0, MAX_BODY);
    if (["document", "text", "example"].includes(item.kind) && !body.trim()) throw new Error("Nenhum texto encontrado no conteúdo.");

    const drafts = chunkItem({ kind: item.kind, title: item.title, body, data: item.data });
    if (!drafts.length) throw new Error("Item sem conteúdo.");

    const ctx = item.kind === "document" && drafts.length > 1 ? await contextualize(item.title, body, drafts) : { contexts: drafts.map(() => ""), usage: emptyUsage() };
    const contexts = ctx.contexts;
    const texts = drafts.map((d, i) => [d.title, contexts[i], d.content].filter(Boolean).join("\n"));
    const { vectors, model, usage: embedUsage } = await embed(texts);
    await recordCost({ agentId: item.agent_id, source: "knowledge", usage: addUsage(ctx.usage, embedUsage), model, meta: { item: item.id, chunks: drafts.length } });

    await sql.begin(async (tx) => {
      await tx`delete from public.knowledge_chunks where item_id = ${item.id}`;
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i]!;
        await tx`
          insert into public.knowledge_chunks (item_id, agent_id, kind, ord, title, content, context, meta, embedding, embedding_model, tokens)
          values (${item.id}, ${item.agent_id}, ${item.kind}, ${d.ord}, ${d.title}, ${d.content}, ${contexts[i] ?? ""},
                  ${tx.json(d.meta as never)}, ${toVector(vectors[i]!)}::extensions.vector, ${model}, ${Math.ceil(texts[i]!.length / 4)})`;
      }
      await tx`
        update public.knowledge_items
        set status = 'ready', error = null, chunk_count = ${drafts.length}, updated_at = now(),
            body = ${readFile && (src.type === "upload" || src.type === "url") ? body : item.body},
            content_hash = ${sha256(texts.join("\n"))}
        where id = ${item.id}`;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn({ itemId, err: msg }, "knowledge: falha ao processar item");
    await sql`update public.knowledge_items set status = 'error', error = ${msg.slice(0, 1000)}, updated_at = now() where id = ${item.id}`;
  }
}

/** Uma frase por trecho dizendo de onde ele é e do que trata (melhora muito a busca). */
async function contextualize(title: string, body: string, drafts: ChunkDraft[]): Promise<{ contexts: string[]; usage: Usage }> {
  const doc = body.slice(0, 14_000);
  const out: string[] = [];
  let usage = emptyUsage();
  for (let i = 0; i < drafts.length; i += 8) {
    const batch = drafts.slice(i, i + 8);
    try {
      const r = await chat({
        model: config().UTILITY_MODEL,
        json: true,
        maxTokens: 1500,
        timeoutMs: 60_000,
        messages: [
          {
            role: "system",
            content:
              'Você situa trechos de um documento para uma busca. Para cada trecho, escreva UMA frase curta em português dizendo de que parte do documento ele é e do que trata. Responda só JSON: {"contextos": ["...", ...]} na mesma ordem.',
          },
          {
            role: "user",
            content:
              `Documento: ${title || "(sem título)"}\n<documento>\n${doc}\n</documento>\n\n` +
              batch.map((d, j) => `<trecho ${j + 1}>\n${d.content.slice(0, 2000)}\n</trecho ${j + 1}>`).join("\n"),
          },
        ],
      });
      usage = addUsage(usage, r.usage);
      const parsed = JSON.parse(r.message.content ?? "{}") as { contextos?: unknown };
      const list = Array.isArray(parsed.contextos) ? parsed.contextos : [];
      batch.forEach((_, j) => out.push(typeof list[j] === "string" ? (list[j] as string).slice(0, 400) : ""));
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : e }, "knowledge: contexto dos trechos falhou (segue sem)");
      batch.forEach(() => out.push(""));
    }
  }
  return { contexts: out, usage };
}
