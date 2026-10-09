import type { FastifyInstance } from "fastify";
import { sha256 } from "../../crypto.js";
import { db } from "../../db.js";
import { log } from "../../log.js";
import { scheduleTurn } from "../../queue.js";
import { redis } from "../../redis.js";
import { normalizeInbound } from "../../runtime/inbound.js";
import { publishedSpec } from "../../runtime/turn.js";

/**
 * Entrada das mensagens do MakeCRM. O Go chama sem autenticação e ignora a
 * resposta, então o token secreto na URL é a autenticação, e respondemos 202
 * na hora: o trabalho vai para a fila.
 */

type Binding = { id: string; agent_id: string; company_id: string; inbox_id: string; enabled: boolean };
const bindingCache = new Map<string, { b: Binding | null; at: number }>();

async function bindingByToken(token: string): Promise<Binding | null> {
  const hash = sha256(token);
  const hit = bindingCache.get(hash);
  if (hit && Date.now() - hit.at < 30_000) return hit.b;
  const [b] = await db()<Binding[]>`
    select id, agent_id, company_id, inbox_id, enabled from public.bindings where token_hash = ${hash} and removed_at is null`;
  bindingCache.set(hash, { b: b ?? null, at: Date.now() });
  return b ?? null;
}

export const lastMessageKey = (conversationId: string) => `conv:last:${conversationId}`;

export async function inboundRoutes(app: FastifyInstance) {
  app.post("/v1/inbound/makecrm/:token", { config: { rawBody: false } }, async (req, reply) => {
    const { token } = req.params as { token: string };
    const binding = token.length > 10 ? await bindingByToken(token) : null;
    if (!binding) return reply.code(404).send({ error: "não encontrado" });
    if (!binding.enabled) return reply.code(202).send({ ignored: "ligação desligada" });

    const msg = normalizeInbound(req.body);
    if ("error" in msg) return reply.code(400).send({ error: msg.error });
    if (msg.inboxId !== binding.inbox_id || msg.companyId !== binding.company_id) {
      log.warn({ binding: binding.id }, "inbound: caixa/empresa diferente da ligação");
      return reply.code(403).send({ error: "caixa diferente da ligação" });
    }
    if (msg.fromMe) return reply.code(202).send({ ignored: "from_me" });
    if (!msg.text && !msg.mediaUrl) return reply.code(202).send({ ignored: "vazia" });

    const published = await publishedSpec(binding.agent_id);
    if (!published) return reply.code(202).send({ ignored: "agente sem versão publicada ou pausado" });

    const sql = db();
    const [conv] = await sql<{ id: string }[]>`
      insert into public.conversations (agent_id, binding_id, company_id, external_id, phone, contact_name, mavi_user_id, last_inbound_at)
      values (${binding.agent_id}, ${binding.id}, ${binding.company_id}, ${msg.conversationId}, ${msg.phone}, ${msg.name}, ${msg.maviUserId}, now())
      on conflict (agent_id, simulation, external_id) do update set
        binding_id = excluded.binding_id,
        phone = coalesce(excluded.phone, public.conversations.phone),
        contact_name = coalesce(excluded.contact_name, public.conversations.contact_name),
        mavi_user_id = coalesce(excluded.mavi_user_id, public.conversations.mavi_user_id),
        last_inbound_at = now(),
        -- O lead respondeu: a régua de follow-up para (recomeça quando ele sumir de novo).
        followup_step = 0, followup_next_at = null, followup_state = 'idle'
      returning id`;
    const media = msg.mediaUrl ? { url: msg.mediaUrl, ...(msg.referral ? { referral: msg.referral } : {}) } : msg.referral ? { referral: msg.referral } : null;
    const [m] = await sql<{ id: string }[]>`
      insert into public.messages (conversation_id, role, content, content_type, media, source_id)
      values (${conv!.id}, 'user', ${msg.text}, ${msg.mediaUrl ? msg.contentType : "text"}, ${media ? sql.json(media as never) : null}, ${msg.sourceId})
      on conflict (conversation_id, source_id) where source_id is not null do nothing
      returning id`;
    if (!m) return reply.code(202).send({ ignored: "repetida" });

    // Só a mensagem mais recente dispara a resposta (as anteriores entram junto).
    await redis().set(lastMessageKey(conv!.id), m.id, "EX", 86_400);
    await scheduleTurn(conv!.id, m.id, published.spec.buffer.seconds * 1000);
    return reply.code(202).send({ ok: true });
  });
}
