import { db } from "../db.js";

/** O que o agente avisa na ferramenta responder (campo `lacunas`), validado e gravado. */

export type GapKind = "question" | "objection";
export type GapDraft = { kind: GapKind; text: string; category: string };

export const OBJECTION_CATEGORIES = ["preco", "prazo", "confianca", "concorrente", "momento", "decisor", "necessidade", "outro"] as const;

/** O que veio no campo `lacunas` (o modelo pode mandar qualquer coisa). */
export function parseGaps(raw: unknown): GapDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: GapDraft[] = [];
  for (const g of raw.slice(0, 3)) {
    if (!g || typeof g !== "object") continue;
    const o = g as Record<string, unknown>;
    const text = String(o.texto ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (text.length < 4) continue;
    const kind: GapKind = /obje/i.test(String(o.tipo ?? "")) ? "objection" : "question";
    const cat = String(o.categoria ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const category = kind === "objection" ? ((OBJECTION_CATEGORIES as readonly string[]).includes(cat) ? cat : "outro") : "";
    if (!out.some((x) => x.text.toLowerCase() === text.toLowerCase())) out.push({ kind, text, category });
  }
  return out;
}

export async function recordGaps(input: {
  agentId: string;
  conversationId: string;
  turnId: string | null;
  leadText: string;
  gaps: GapDraft[];
  /** live: conversa real; test: achada num teste com lead simulado. */
  origin?: "live" | "test";
}) {
  if (!input.gaps.length) return;
  const sql = db();
  for (const g of input.gaps) {
    await sql`
      insert into public.gaps (agent_id, conversation_id, turn_id, kind, text, category, lead_text, origin)
      values (${input.agentId}, ${input.conversationId}, ${input.turnId}, ${g.kind}, ${g.text}, ${g.category}, ${input.leadText.slice(0, 1000)},
              ${input.origin ?? "live"})`;
  }
}
