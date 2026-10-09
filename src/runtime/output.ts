import type { AgentSpec } from "../spec/agent.js";

/** Ajustes finais no texto antes de enviar (o que o mavi-llm já fazia + limites). */

export type ReplyMessage = { text: string; media: string[] };

export function cleanText(text: string, spec: AgentSpec): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  // Markdown que o WhatsApp não mostra.
  t = t.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#{1,6}\s+/gm, "");
  if (spec.output.no_em_dash) t = t.replace(/\s*—\s*/g, ", ").replace(/,\s*,/g, ",");
  if (spec.output.strip_trailing_period) t = t.replace(/(?<!\.)\.$/, "");
  return t.trim();
}

/** Acima disto, um balão é quebrado em dois (se ainda couber no limite de mensagens). */
export const LONG_MESSAGE = 160;

const SENTENCE_END = /(?<=[.!?…]|\p{Extended_Pictographic})[ \t]+(?=[\p{Lu}\p{Extended_Pictographic}"“(¡¿])/gu;
const isList = (p: string) => /^\s*([-*•]|\d+[.)])\s/m.test(p);

/**
 * Onde dá para cortar o texto sem estragar: entre parágrafos, entre linhas e
 * entre frases (menos dentro de listas). Devolve as posições de corte.
 */
function cutPoints(text: string): { at: number; skip: number }[] {
  const cuts: { at: number; skip: number }[] = [];
  for (const m of text.matchAll(/\n\s*/g)) cuts.push({ at: m.index!, skip: m[0].length });
  let start = 0;
  for (const para of text.split(/\n/)) {
    if (!isList(para)) for (const m of para.matchAll(SENTENCE_END)) cuts.push({ at: start + m.index!, skip: m[0].length });
    start += para.length + 1;
  }
  return cuts;
}

/** Quebra em dois no corte mais equilibrado; null se não houver onde cortar. */
export function splitInTwo(text: string): [string, string] | null {
  let best: [string, string] | null = null;
  let bestSize = Infinity;
  for (const c of cutPoints(text)) {
    const a = text.slice(0, c.at).trim();
    const b = text.slice(c.at + c.skip).trim();
    if (!a || !b) continue;
    const size = Math.max(a.length, b.length);
    if (size < bestSize) [best, bestSize] = [[a, b], size];
  }
  return best;
}

/**
 * Como uma pessoa no WhatsApp: enquanto houver um balão longo e couber mais
 * um, quebra o mais longo em dois (o modelo às vezes manda tudo num item só).
 */
export function splitLong(items: ReplyMessage[], max: number): ReplyMessage[] {
  const out = [...items];
  while (out.length < max) {
    let i = -1;
    for (let j = 0; j < out.length; j++) if (out[j]!.text.length > LONG_MESSAGE && (i < 0 || out[j]!.text.length > out[i]!.text.length)) i = j;
    if (i < 0) break;
    const parts = splitInTwo(out[i]!.text);
    if (!parts) break;
    out.splice(i, 1, { text: parts[0], media: out[i]!.media }, { text: parts[1], media: [] });
  }
  return out;
}

export function normalizeReply(raw: unknown, spec: AgentSpec): ReplyMessage[] {
  if (!Array.isArray(raw)) return [];
  const items: ReplyMessage[] = [];
  for (const m of raw) {
    const text = typeof m === "string" ? m : m && typeof m === "object" ? String((m as { texto?: unknown }).texto ?? "") : "";
    const media = m && typeof m === "object" && Array.isArray((m as { midias?: unknown }).midias)
      ? ((m as { midias: unknown[] }).midias.filter((x) => typeof x === "string") as string[])
      : [];
    items.push({ text: text.replace(/\r\n/g, "\n").trim(), media });
  }
  const out: ReplyMessage[] = [];
  for (const m of splitLong(items, spec.output.max_messages)) {
    const clean = cleanText(m.text, spec);
    if (clean || m.media.length) out.push({ text: clean, media: m.media });
  }
  if (out.length <= spec.output.max_messages) return out;
  // Junta o excedente na última mensagem permitida em vez de perder conteúdo.
  const head = out.slice(0, spec.output.max_messages - 1);
  const tail = out.slice(spec.output.max_messages - 1);
  head.push({ text: tail.map((m) => m.text).filter(Boolean).join("\n\n"), media: tail.flatMap((m) => m.media) });
  return head;
}

/** Texto solto (quando o modelo não chamou responder): parágrafos viram mensagens. */
export function splitPlainText(text: string, spec: AgentSpec): ReplyMessage[] {
  return normalizeReply(
    text.split(/\n\s*\n/).map((t) => ({ texto: t })),
    spec,
  );
}

/** Pausa de "digitação" entre mensagens: 0,8 s + 25 ms por caractere, até 4 s. */
export const typingDelayMs = (text: string) => Math.min(4000, 800 + text.length * 25);
