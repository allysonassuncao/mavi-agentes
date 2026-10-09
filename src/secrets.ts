import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import type { AgentKeys } from "./llm/client.js";
import type { ProviderKind } from "./llm/providers.js";

/** Cofre das chaves de API dos agentes (AES-256-GCM com SECRETS_KEY). */

export class SecretsError extends Error {}

function masterKey(): Buffer {
  const raw = config().SECRETS_KEY;
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new SecretsError("O cofre de chaves do motor não está configurado (SECRETS_KEY com 32 bytes em base64).");
  return key;
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), data]).toString("base64")}`;
}

export function unseal(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new SecretsError("Chave em formato desconhecido.");
  const buf = Buffer.from(sealed.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", masterKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

const cache = new Map<string, { keys: AgentKeys; at: number }>();

/** As chaves do agente, abertas (em memória por 60 s). */
export async function agentKeys(agentId: string): Promise<AgentKeys> {
  const hit = cache.get(agentId);
  if (hit && Date.now() - hit.at < 60_000) return hit.keys;
  const rows = await db()<{ provider: ProviderKind; key_cipher: string }[]>`
    select provider, key_cipher from public.agent_secrets where agent_id = ${agentId}`;
  const keys: AgentKeys = {};
  for (const r of rows) {
    try {
      keys[r.provider] = unseal(r.key_cipher);
    } catch {
      /* chave que não abre (cofre trocado): o motor usa a dele */
    }
  }
  cache.set(agentId, { keys, at: Date.now() });
  return keys;
}

export const forgetAgentKeys = (agentId: string) => cache.delete(agentId);
