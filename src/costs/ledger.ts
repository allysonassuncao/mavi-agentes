import { db } from "../db.js";
import type { Usage } from "../llm/client.js";
import { parseModelRef } from "../llm/providers.js";
import { log } from "../log.js";

/**
 * Registro de custos: cada gasto separado (a resposta, a transcrição do áudio,
 * a busca no conhecimento, o modelo aprovado do WhatsApp…), ligado ao agente,
 * à conversa, à mensagem e à caixa. Nunca derruba quem chamou.
 */

export type CostSource =
  | "reply"
  | "followup"
  | "media_audio"
  | "media_image"
  | "media_video"
  | "media_document"
  | "retrieval"
  | "summary"
  | "knowledge"
  | "gaps"
  | "insight"
  | "reading"
  | "waba_template"
  | "test_persona"
  | "test_lead"
  | "test_judge";

export type CostEvent = {
  agentId: string;
  source: CostSource;
  conversationId?: string | null;
  messageId?: string | number | null;
  turnId?: string | null;
  simulation?: boolean;
  model?: string | null;
  usage?: Usage | null;
  /** Segundos de áudio/vídeo, 1 modelo aprovado… */
  units?: number;
  /** Quando não vem de um uso de LLM (modelo aprovado do WhatsApp). */
  costUsd?: number;
  meta?: Record<string, unknown>;
};

/** O provedor de um modelo ("openrouter:openai/gpt-5.2" → openrouter; "gpt-4o-mini-transcribe" → openai). */
export function providerOf(model: string | null | undefined): string | null {
  if (!model) return null;
  try {
    return parseModelRef(model).kind;
  } catch {
    return null;
  }
}

export async function recordCost(e: CostEvent): Promise<void> {
  const cost = e.costUsd ?? e.usage?.costUsd ?? 0;
  const tokensIn = e.usage?.tokensIn ?? 0;
  const tokensOut = e.usage?.tokensOut ?? 0;
  // Nada gasto, nada a registrar.
  if (!cost && !tokensIn && !tokensOut && !e.units) return;
  try {
    const sql = db();
    await sql`
      insert into public.cost_events (agent_id, company_id, conversation_id, inbox_id, message_id, turn_id, simulation, source,
                                      provider, model, tokens_in, tokens_out, tokens_cached, units, cost_usd, meta)
      select a.id, a.company_id, ${e.conversationId ?? null}::uuid,
             (select b.inbox_id from public.conversations c join public.bindings b on b.id = c.binding_id where c.id = ${e.conversationId ?? null}::uuid),
             ${e.messageId == null ? null : String(e.messageId)}::bigint, ${e.turnId ?? null}::uuid, ${e.simulation ?? false}, ${e.source},
             ${providerOf(e.model)}, ${e.model ?? null}, ${tokensIn}, ${tokensOut}, ${e.usage?.tokensCached ?? 0},
             ${e.units ?? 0}, ${cost}, ${sql.json((e.meta ?? {}) as never)}
      from public.agents a where a.id = ${e.agentId}`;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), source: e.source }, "custos: não registrou");
  }
}

// ---------------------------------------------------------------- WhatsApp Business API

/** País pelo DDI do telefone (o que a Meta usa para o preço). */
const DDI: [string, string][] = [
  ["351", "PT"],
  ["55", "BR"],
  ["54", "AR"],
  ["52", "MX"],
  ["57", "CO"],
  ["56", "CL"],
  ["51", "PE"],
  ["598", "UY"],
  ["595", "PY"],
  ["591", "BO"],
  ["34", "ES"],
  ["44", "GB"],
  ["1", "US"],
];
export function countryOf(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return [...DDI].sort((a, b) => b[0].length - a[0].length).find(([d]) => digits.startsWith(d))?.[1] ?? "*";
}

export function categoryOf(raw: string | null | undefined): "marketing" | "utility" | "authentication" {
  const c = String(raw ?? "").toLowerCase();
  return c.startsWith("auth") ? "authentication" : c.startsWith("util") ? "utility" : "marketing";
}

/** Preço de um modelo aprovado (país, senão a linha "outros"). */
export async function wabaPrice(country: string, category: string): Promise<number> {
  const rows = await db()<{ country: string; price_usd: string }[]>`
    select country, price_usd from public.waba_prices where category = ${category} and country in (${country}, '*')`;
  const row = rows.find((r) => r.country === country) ?? rows.find((r) => r.country === "*");
  return row ? Number(row.price_usd) : 0;
}
