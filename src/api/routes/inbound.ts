import type { FastifyInstance } from "fastify";
import { sha256 } from "../../crypto.js";
import { db } from "../../db.js";
import { log } from "../../log.js";
import { normalizeInbound } from "../../runtime/inbound.js";
import { receiveMessage } from "../../runtime/receive.js";
import { linkSiteHandoff } from "../../webchat/service.js";

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

export { lastMessageKey } from "../../runtime/receive.js";

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

    const r = await receiveMessage(binding, msg);
    // Veio do Chat do site pelo "Continuar no WhatsApp": a equipe e o agente recebem o resumo.
    await linkSiteHandoff(msg).catch((e) => log.warn({ err: String(e) }, "inbound: código do site não ligado"));
    if (r !== "ok") return reply.code(202).send({ ignored: r });
    return reply.code(202).send({ ok: true });
  });
}
