import { config } from "../config.js";
import { db, toVector } from "../db.js";
import { addUsage, chat, embed, emptyUsage, type Usage } from "../llm/client.js";
import { log } from "../log.js";

export type Retrieved = {
  chunk_id: string;
  item_id: string;
  kind: string;
  title: string;
  content: string;
  context: string;
  meta: Record<string, unknown>;
  score: number;
  vector_rank: number | null;
  keyword_rank: number | null;
};

/** Busca híbrida (vetor + palavra-chave) na base do agente, com reordenação opcional. */
export async function searchKnowledge(opts: {
  agentId: string;
  query: string;
  k: number;
  kinds?: string[] | null;
  rerank?: boolean;
}): Promise<{ results: Retrieved[]; usage: Usage }> {
  const query = opts.query.trim().slice(0, 4000);
  if (!query || opts.k <= 0) return { results: [], usage: emptyUsage() };
  let usage = emptyUsage();
  const e = await embed([query]);
  usage = addUsage(usage, e.usage);
  const pool = opts.rerank ? Math.min(opts.k * 3, 30) : opts.k;
  const rows = await db()<Retrieved[]>`
    select * from public.kb_search(${opts.agentId}, ${toVector(e.vectors[0]!)}::extensions.vector, ${query}, ${pool},
                                   ${opts.kinds?.length ? opts.kinds : null})`;
  if (!opts.rerank || rows.length <= opts.k) return { results: rows.slice(0, opts.k), usage };
  const r = await rerank(query, rows, opts.k);
  return { results: r.results, usage: addUsage(usage, r.usage) };
}

async function rerank(query: string, rows: Retrieved[], k: number): Promise<{ results: Retrieved[]; usage: Usage }> {
  try {
    const r = await chat({
      model: config().UTILITY_MODEL,
      json: true,
      maxTokens: 400,
      timeoutMs: 20_000,
      messages: [
        {
          role: "system",
          content: `Ordene os trechos pelo quanto ajudam a responder a mensagem. Responda só JSON: {"ordem": [números dos ${k} melhores, do melhor para o pior]}.`,
        },
        {
          role: "user",
          content: `Mensagem: ${query}\n\n` + rows.map((x, i) => `[${i + 1}] ${x.title ? `${x.title}: ` : ""}${x.content.slice(0, 600)}`).join("\n\n"),
        },
      ],
    });
    const ordem = (JSON.parse(r.message.content ?? "{}") as { ordem?: unknown }).ordem;
    const picked: Retrieved[] = [];
    const seen = new Set<number>();
    if (Array.isArray(ordem)) {
      for (const n of ordem) {
        const i = Number(n) - 1;
        if (Number.isInteger(i) && rows[i] && !seen.has(i)) {
          seen.add(i);
          picked.push(rows[i]!);
        }
        if (picked.length >= k) break;
      }
    }
    for (let i = 0; picked.length < k && i < rows.length; i++) if (!seen.has(i)) picked.push(rows[i]!);
    return { results: picked, usage: r.usage };
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : e }, "knowledge: reordenação falhou (usa a ordem da busca)");
    return { results: rows.slice(0, k), usage: emptyUsage() };
  }
}
