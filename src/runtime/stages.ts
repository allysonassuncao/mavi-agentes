import { db } from "../db.js";
import type { AgentSpec } from "../spec/agent.js";
import type { StageRuleT, StageT } from "../spec/stages.js";

/**
 * A etapa da conversa (aba Etapas): decidida sem IA, a cada vez, pelo que já
 * aconteceu. De cima para baixo, vale a primeira etapa cujas regras batem.
 *
 * A retomada (lead voltou depois de X dias sem mensagem do agente) recomeça a
 * etapa: grava em facts._etapa_desde a partir de quando as frases do agente
 * contam e apaga os dados usados nas regras. Dados com "_" no começo são do
 * sistema e não vão para o agente.
 */

export const STAGE_SINCE = "_etapa_desde";

const fold = (v: unknown) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";

export function ruleMatches(rule: StageRuleT, facts: Record<string, unknown>, said: string[]): boolean {
  if (rule.type === "fact") {
    const v = facts[rule.field];
    if (rule.op === "filled") return filled(v);
    if (!filled(v)) return false;
    return rule.op === "equals" ? fold(v) === fold(rule.value) : fold(v).includes(fold(rule.value));
  }
  const texts = rule.texts.map(fold);
  return said.some((m) => {
    const f = fold(m);
    return texts.some((t) => f.includes(t));
  });
}

/** A etapa para estes dados e mensagens do agente (puro: também usado nos testes e no Testar). */
export function pickStage(spec: AgentSpec, facts: Record<string, unknown>, said: string[]): StageT | null {
  if (!spec.stages.enabled) return null;
  for (const st of spec.stages.items) {
    if (!st.enabled) continue;
    const rules = st.when.rules;
    if (!rules.length) return st;
    const hit = st.when.mode === "all" ? rules.every((r) => ruleMatches(r, facts, said)) : rules.some((r) => ruleMatches(r, facts, said));
    if (hit) return st;
  }
  return null;
}

/** Os dados usados nas regras das etapas (são os apagados na retomada). */
export function stageFactFields(spec: AgentSpec): string[] {
  const out = new Set<string>();
  for (const st of spec.stages.items) for (const r of st.when.rules) if (r.type === "fact") out.add(r.field);
  return [...out];
}

export type StageState = { stage: StageT | null; restarted: boolean };

/**
 * A etapa desta vez. `facts` é atualizado no lugar quando a etapa recomeça.
 * Sem etapas configuradas não lê nada do banco.
 */
export async function currentStage(
  spec: AgentSpec,
  conv: { id: string; facts: Record<string, unknown>; last_reply_at?: Date | null },
  opts: { now?: Date; allowRestart?: boolean } = {},
): Promise<StageState> {
  const now = opts.now ?? new Date();
  if (!spec.stages.enabled || !spec.stages.items.some((s) => s.enabled)) return { stage: null, restarted: false };
  const sql = db();
  let restarted = false;
  const days = spec.stages.restart_after_days;
  // Só a resposta a uma mensagem do lead recomeça (follow-up e lembretes só leem a etapa).
  if (days && opts.allowRestart !== false && conv.last_reply_at && now.getTime() - conv.last_reply_at.getTime() >= days * 86_400_000) {
    const since = now.toISOString();
    const drop = stageFactFields(spec);
    const facts = Object.fromEntries(Object.entries(conv.facts).filter(([k]) => !drop.includes(k)));
    facts[STAGE_SINCE] = since;
    conv.facts = facts;
    await sql`update public.conversations set facts = ${sql.json(facts as never)} where id = ${conv.id}`;
    restarted = true;
  }
  const needsSaid = spec.stages.items.some((s) => s.enabled && s.when.rules.some((r) => r.type === "said"));
  let said: string[] = [];
  if (needsSaid && !restarted) {
    const since = typeof conv.facts[STAGE_SINCE] === "string" ? new Date(conv.facts[STAGE_SINCE] as string) : null;
    const rows = await sql<{ content: string }[]>`
      select content from public.messages
      where conversation_id = ${conv.id} and role = 'assistant'
        ${since && !Number.isNaN(since.getTime()) ? sql`and created_at >= ${since}` : sql``}
      order by id desc limit 400`;
    said = rows.map((r) => r.content);
  }
  return { stage: pickStage(spec, conv.facts, said), restarted };
}

/** Os dados que vão para o agente (sem os do sistema, que começam com "_"). */
export const visibleFacts = (facts: Record<string, unknown>) => Object.fromEntries(Object.entries(facts).filter(([k]) => !k.startsWith("_")));
