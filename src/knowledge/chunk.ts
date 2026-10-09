/**
 * Divide cada item da base em trechos, conforme o tipo:
 * - faq, product, media: um trecho por item (a unidade já é a resposta certa);
 * - document, text, example: blocos de ~1.400 caracteres respeitando parágrafos,
 *   com sobreposição curta para a ideia não ficar cortada ao meio.
 */

export type KnowledgeKind = "faq" | "product" | "document" | "media" | "example" | "text";

export type ChunkDraft = {
  ord: number;
  title: string;
  content: string;
  meta: Record<string, unknown>;
};

export type ItemForChunking = {
  kind: KnowledgeKind;
  title: string;
  body: string;
  data: Record<string, unknown>;
};

const TARGET = 1400;
const MAX = 2000;
const OVERLAP = 200;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

export function formatProduct(data: Record<string, unknown>): string {
  const lines: string[] = [];
  const name = str(data.name);
  if (name) lines.push(`Produto: ${name}`);
  if (data.price != null && data.price !== "") lines.push(`Preço: ${str(data.price)}`);
  if (str(data.sku)) lines.push(`Código: ${str(data.sku)}`);
  if (str(data.category)) lines.push(`Categoria: ${str(data.category)}`);
  if (str(data.description)) lines.push(str(data.description));
  const attrs = data.attributes;
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) if (str(v)) lines.push(`${k}: ${str(v)}`);
  }
  return lines.join("\n");
}

/** Divide texto longo em blocos perto de TARGET, cortando em parágrafo, depois frase. */
export function splitText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= MAX) return [clean];

  const paragraphs = clean.split(/\n\s*\n/);
  // Parágrafos gigantes viram frases.
  const units: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= MAX) units.push(p);
    else units.push(...splitLong(p));
  }

  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > TARGET) {
      chunks.push(cur);
      const tail = cur.slice(-OVERLAP);
      const cut = tail.search(/[.!?\n]\s/);
      cur = (cut >= 0 ? tail.slice(cut + 2) : "").trim();
      cur = cur ? `${cur}\n\n${u}` : u;
    } else {
      cur = cur ? `${cur}\n\n${u}` : u;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function splitLong(p: string): string[] {
  const sentences = p.match(/[^.!?\n]+[.!?]*\s*/g) ?? [p];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > MAX) {
      if (cur) out.push(cur.trim());
      cur = "";
      for (let i = 0; i < s.length; i += TARGET) out.push(s.slice(i, i + TARGET).trim());
      continue;
    }
    if (cur.length + s.length > TARGET && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function chunkItem(item: ItemForChunking): ChunkDraft[] {
  switch (item.kind) {
    case "faq": {
      const q = str(item.data.question) || item.title;
      const a = str(item.data.answer) || item.body;
      if (!q && !a) return [];
      return [{ ord: 0, title: q, content: a, meta: {} }];
    }
    case "product": {
      const content = formatProduct(item.data) || item.body;
      if (!content) return [];
      const { attributes, ...rest } = item.data;
      return [{ ord: 0, title: str(item.data.name) || item.title, content, meta: { ...rest, ...(attributes && typeof attributes === "object" ? { attributes } : {}) } }];
    }
    case "media": {
      const description = str(item.data.description) || item.body;
      return [
        {
          ord: 0,
          title: item.title,
          content: description || item.title,
          meta: { url: item.data.url, storage_path: item.data.storage_path, mime: item.data.mime, media_kind: item.data.media_kind },
        },
      ];
    }
    default:
      return splitText(item.body).map((content, ord) => ({ ord, title: item.title, content, meta: {} }));
  }
}
