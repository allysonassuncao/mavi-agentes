import { db } from "../db.js";
import { redis } from "../redis.js";
import { sendMessage, type OutgoingAttachment } from "../makecrm/client.js";
import { insertMessage } from "../webchat/makecrm.js";

/**
 * Envia uma mensagem do agente pelo canal da conversa: WhatsApp pela
 * sendMessage do MakeCRM; Chat do site gravando direto na caixa (o widget lê
 * de lá). Mesmo formato da sendMessage, para a resposta, o follow-up, a
 * pré-reunião e os retornos.
 */

type Channel = { channel: "whatsapp" | "webchat"; inbox_id: string | null };
const cache = new Map<string, { c: Channel; at: number }>();

async function channelOf(conversationId: string): Promise<Channel> {
  const hit = cache.get(conversationId);
  if (hit && Date.now() - hit.at < 300_000) return hit.c;
  const [row] = await db()<Channel[]>`
    select b.channel, b.inbox_id from public.conversations c join public.bindings b on b.id = c.binding_id
    where c.external_id = ${conversationId} and not c.simulation
    order by c.last_inbound_at desc nulls last limit 1`;
  const c: Channel = row ?? { channel: "whatsapp", inbox_id: null };
  if (cache.size > 5000) cache.clear();
  cache.set(conversationId, { c, at: Date.now() });
  return c;
}

/** "O agente está escrevendo" no widget enquanto a resposta não sai. */
export const typingKey = (makecrmConversationId: string) => `wc:typing:${makecrmConversationId}`;

export async function deliverMessage(input: {
  companyId: string;
  userId: string | null;
  conversationId: string;
  content: string;
  attachments?: OutgoingAttachment[];
}): Promise<void> {
  const ch = await channelOf(input.conversationId);
  if (ch.channel !== "webchat" || !ch.inbox_id) return sendMessage(input);
  // No site, as mídias viram links (o widget mostra a imagem quando é imagem).
  const links = (input.attachments ?? []).map((a) => a.url);
  const content = [input.content, ...links].filter(Boolean).join("\n");
  await insertMessage({ inboxId: ch.inbox_id, conversationId: input.conversationId, type: "outcoming", content, userId: input.userId });
  await redis().del(typingKey(input.conversationId)).catch(() => {});
}
