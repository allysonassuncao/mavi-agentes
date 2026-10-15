import type postgres from "postgres";
import type { AgentSpec } from "../spec/agent.js";

/**
 * Ativação por gatilho (spec.activation): enquanto a conversa não foi ativada,
 * as mensagens do lead ficam guardadas sem resposta; a que traz um dos termos
 * ativa a conversa e as anteriores passam a ser histórico (contexto), não
 * pendentes. A conversa fica ativa até a memória ser zerada.
 */

/** Minúsculas, sem acentos e com os espaços juntos. */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Para "exato": sem pontuação nem emoji nas pontas ("Promoção!" = "promocao"). */
const trimEdges = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** O termo que ativa a conversa nesta mensagem, ou null. */
export function matchActivation(terms: AgentSpec["activation"]["terms"], text: string): string | null {
  const msg = foldText(text);
  if (!msg) return null;
  for (const t of terms) {
    const term = foldText(t.term);
    if (!term) continue;
    if (t.match === "exact" ? trimEdges(msg) === (trimEdges(term) || term) : msg.includes(term)) return t.term;
  }
  return null;
}

/**
 * Ativa a conversa pela mensagem do gatilho: as mensagens do lead anteriores
 * a ela, ainda sem resposta, vão para um rastro "pulado" (entram no histórico
 * como contexto e não são respondidas). false = outra mensagem já ativou.
 */
export async function activateConversation(
  sql: postgres.Sql,
  conv: { id: string; agentId: string; simulation: boolean; version: number | null },
  triggerMessageId: string,
  term: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [ok] = await tx`update public.conversations set activated_at = now() where id = ${conv.id} and activated_at is null returning id`;
    if (!ok) return false;
    const before = await tx<{ id: string }[]>`
      select id from public.messages
      where conversation_id = ${conv.id} and role = 'user' and turn_id is null and id < ${triggerMessageId}
      order by id`;
    if (before.length) {
      const [t] = await tx<{ id: string }[]>`
        insert into public.turns (conversation_id, agent_id, agent_version, simulation, status, input_message_ids, output)
        values (${conv.id}, ${conv.agentId}, ${conv.version}, ${conv.simulation}, 'skipped', ${before.map((m) => m.id)}::bigint[],
                ${tx.json({ messages: [], before_activation: true, silent_reason: `mensagens antes do gatilho "${term}": guardadas como contexto` } as never)})
        returning id`;
      await tx`update public.messages set turn_id = ${t!.id} where id in ${tx(before.map((m) => m.id))}`;
    }
    return true;
  }) as Promise<boolean>;
}

/** Texto que o simulador mostra quando a mensagem não ativou o agente. */
export const WAITING_TRIGGER = "aguardando o gatilho: a mensagem não tem nenhum dos termos de ativação";
