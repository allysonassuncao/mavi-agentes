import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { serverProviders } from "../../llm/client.js";
import { isProvider, PROVIDERS, type ProviderKind } from "../../llm/providers.js";
import { forgetAgentKeys, seal, SecretsError } from "../../secrets.js";
import { HttpError, parseBody } from "../http.js";
import { loadAgent } from "./agents.js";

/**
 * Chaves de API próprias do agente (cada agente paga as suas conversas). A
 * chave entra e nunca mais sai: a API devolve só o final dela.
 */

const provider = (p: string): ProviderKind => {
  if (!isProvider(p)) throw new HttpError(400, "Provedor desconhecido.");
  return p;
};

/** Confere a chave no provedor (lista de modelos: não gasta nada). */
async function checkKey(kind: ProviderKind, key: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const res = await fetch(`${PROVIDERS[kind].base}/models`, {
      headers: kind === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, error: null };
    return { ok: false, error: res.status === 401 || res.status === 403 ? "A chave foi recusada pelo provedor." : `O provedor respondeu ${res.status}.` };
  } catch {
    return { ok: false, error: "Não consegui falar com o provedor agora." };
  }
}

export async function secretRoutes(app: FastifyInstance) {
  /** Os provedores que o motor fala e os que têm chave do próprio motor (reserva). */
  app.get("/v1/meta/providers", async () => ({
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label })),
    server_providers: serverProviders(),
  }));

  app.get("/v1/agents/:id/secrets", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const secrets = await db()`
      select provider, key_hint, checked_at, check_ok, check_error, updated_by, updated_at
      from public.agent_secrets where agent_id = ${a.id} order by provider`;
    return { secrets, server_providers: serverProviders() };
  });

  app.put("/v1/agents/:id/secrets/:provider", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const kind = provider((req.params as { provider: string }).provider);
    const body = parseBody(z.object({ key: z.string().trim().min(10).max(500), updated_by: z.string().max(200).optional() }), req.body);
    let cipher: string;
    try {
      cipher = seal(body.key);
    } catch (e) {
      if (e instanceof SecretsError) throw new HttpError(503, e.message);
      throw e;
    }
    const check = await checkKey(kind, body.key);
    await db()`
      insert into public.agent_secrets (agent_id, provider, key_cipher, key_hint, checked_at, check_ok, check_error, updated_by)
      values (${a.id}, ${kind}, ${cipher}, ${body.key.slice(-4)}, now(), ${check.ok}, ${check.error}, ${body.updated_by ?? req.client!.name})
      on conflict (agent_id, provider) do update set
        key_cipher = excluded.key_cipher, key_hint = excluded.key_hint, checked_at = excluded.checked_at,
        check_ok = excluded.check_ok, check_error = excluded.check_error, updated_by = excluded.updated_by, updated_at = now()`;
    forgetAgentKeys(a.id);
    return { provider: kind, key_hint: body.key.slice(-4), check_ok: check.ok, check_error: check.error };
  });

  app.delete("/v1/agents/:id/secrets/:provider", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const kind = provider((req.params as { provider: string }).provider);
    await db()`delete from public.agent_secrets where agent_id = ${a.id} and provider = ${kind}`;
    forgetAgentKeys(a.id);
    return { ok: true };
  });
}
