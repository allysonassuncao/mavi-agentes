import { redis } from "../redis.js";
import type { RepeatT } from "../spec/integrations.js";
import type { ActionDebug } from "./debug.js";

/**
 * A trava de repetição das ações do agente numa conversa (Repeat da
 * especificação). "always" só segura a mesma chamada repetida na mesma vez
 * (30 s); "window" segura pelos minutos escolhidos; "conversation", até zerar
 * a memória do lead (que apaga as travas "once:<conversa>:*").
 */

const FOREVER = 400 * 86_400;
export const repeatKey = (conversationId: string, key: string) => `once:${conversationId}:${key}`;

export type Claim = { ok: true; release: () => Promise<void> } | { ok: false; until: Date | null };

export async function claimRepeat(conversationId: string, key: string, repeat: RepeatT): Promise<Claim> {
  const k = repeatKey(conversationId, key);
  const seconds = repeat.mode === "always" ? 30 : repeat.mode === "window" ? repeat.minutes * 60 : FOREVER;
  if (await redis().set(k, String(Date.now()), "EX", seconds, "NX")) return { ok: true, release: async () => void (await redis().del(k)) };
  const ttl = await redis().ttl(k);
  return { ok: false, until: repeat.mode === "conversation" || ttl < 0 ? null : new Date(Date.now() + ttl * 1000) };
}

/** O que o agente lê quando a ação já foi feita (segue a conversa sem comentar). */
export function blockedMessage(c: Extract<Claim, { ok: false }>, what: string): string {
  const until = c.until ? ` (de novo só depois de ${c.until.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })})` : "";
  return `${what} já foi feito nesta conversa e não se repete agora${until}. Não tente de novo; siga a conversa sem comentar.`;
}

/** Faz a ação com a trava: se der erro, libera para poder tentar de novo. */
/** O diagnóstico de uma ação segurada pela configuração de repetição. */
export function blockedDebug(c: Extract<Claim, { ok: false }>, what: string, repeat: RepeatT): ActionDebug {
  const when = c.until ? c.until.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;
  return {
    outcome: "blocked",
    code: "repeat_blocked",
    summary: `${what}: já feito nesta conversa; não repetiu${when ? ` (liberado de novo em ${when})` : " (uma vez por conversa)"}.`,
    hint:
      repeat.mode === "conversation"
        ? "Configurado para uma vez por conversa. Para permitir de novo, mude \"Repetir na mesma conversa\" ou zere a memória do lead."
        : `Configurado para no máximo uma vez a cada ${repeat.minutes} min. Ajuste em "Repetir na mesma conversa", se precisar.`,
  };
}

export async function withRepeat<T>(
  conversationId: string,
  key: string,
  repeat: RepeatT,
  what: string,
  fn: () => Promise<T>,
): Promise<T | { result: string; silent: true; debug: ActionDebug }> {
  const c = await claimRepeat(conversationId, key, repeat);
  if (!c.ok) return { result: blockedMessage(c, what), silent: true, debug: blockedDebug(c, what, repeat) };
  try {
    return await fn();
  } catch (e) {
    await c.release().catch(() => {});
    throw e;
  }
}
