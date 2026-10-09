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

export function normalizeReply(raw: unknown, spec: AgentSpec): ReplyMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplyMessage[] = [];
  for (const m of raw) {
    const text = typeof m === "string" ? m : m && typeof m === "object" ? String((m as { texto?: unknown }).texto ?? "") : "";
    const media = m && typeof m === "object" && Array.isArray((m as { midias?: unknown }).midias)
      ? ((m as { midias: unknown[] }).midias.filter((x) => typeof x === "string") as string[])
      : [];
    const clean = cleanText(text, spec);
    if (clean || media.length) out.push({ text: clean, media });
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
