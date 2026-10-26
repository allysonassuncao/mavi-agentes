import { db } from "../db.js";
import { scheduleTurn } from "../queue.js";
import { redis } from "../redis.js";
import { activateConversation, matchActivation } from "./activation.js";
import type { Inbound } from "./inbound.js";
import { publishedSpec } from "./turn.js";

/**
 * Uma mensagem do lead chegou numa caixa ligada (WhatsApp pelo Go ou Chat do
 * site pelo widget): guarda na conversa do motor e agenda a resposta. Devolve
 * "ok" ou o motivo de ter ignorado.
 */

export type ReceivingBinding = { id: string; agent_id: string; company_id: string };

export const lastMessageKey = (conversationId: string) => `conv:last:${conversationId}`;

export async function receiveMessage(binding: ReceivingBinding, msg: Inbound): Promise<string> {
  const published = await publishedSpec(binding.agent_id);
  if (!published) return "agente sem versão publicada ou pausado";

  const sql = db();
  // Sem gatilho, a conversa já nasce ativa (e continua ativa se o gatilho for ligado depois).
  const gate = published.spec.activation;
  const [conv] = await sql<{ id: string; activated_at: Date | null }[]>`
    insert into public.conversations (agent_id, binding_id, company_id, external_id, phone, contact_name, mavi_user_id, last_inbound_at, activated_at)
    values (${binding.agent_id}, ${binding.id}, ${binding.company_id}, ${msg.conversationId}, ${msg.phone}, ${msg.name}, ${msg.maviUserId}, now(),
            case when ${gate.enabled}::boolean then null else now() end)
    on conflict (agent_id, simulation, external_id) do update set
      binding_id = excluded.binding_id,
      phone = coalesce(excluded.phone, public.conversations.phone),
      contact_name = coalesce(excluded.contact_name, public.conversations.contact_name),
      mavi_user_id = coalesce(excluded.mavi_user_id, public.conversations.mavi_user_id),
      last_inbound_at = now(),
      activated_at = coalesce(public.conversations.activated_at, excluded.activated_at),
      -- O lead respondeu: a régua de follow-up para (recomeça quando ele sumir de novo).
      followup_step = 0, followup_next_at = null, followup_state = 'idle'
    returning id, activated_at`;
  const media = msg.mediaUrl ? { url: msg.mediaUrl, ...(msg.referral ? { referral: msg.referral } : {}) } : msg.referral ? { referral: msg.referral } : null;
  const [m] = await sql<{ id: string }[]>`
    insert into public.messages (conversation_id, role, content, content_type, media, source_id)
    values (${conv!.id}, 'user', ${msg.text}, ${msg.mediaUrl ? msg.contentType : "text"}, ${media ? sql.json(media as never) : null}, ${msg.sourceId})
    on conflict (conversation_id, source_id) where source_id is not null do nothing
    returning id`;
  if (!m) return "repetida";

  // Gatilho: sem o termo a mensagem fica guardada (contexto) e ninguém responde.
  if (gate.enabled && !conv!.activated_at) {
    const term = matchActivation(gate.terms, msg.text);
    if (!term) return "aguardando o gatilho";
    await activateConversation(sql, { id: conv!.id, agentId: binding.agent_id, simulation: false, version: published.version }, m.id, term);
  }

  // Só a mensagem mais recente dispara a resposta (as anteriores entram junto).
  await redis().set(lastMessageKey(conv!.id), m.id, "EX", 86_400);
  await scheduleTurn(conv!.id, m.id, published.spec.buffer.seconds * 1000);
  return "ok";
}
