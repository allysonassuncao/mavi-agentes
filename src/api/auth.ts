import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { sha256 } from "../crypto.js";

/** Quem chama a API de administração (MAVI Tasks, construtor do MakeCRM…). */
export type ApiClient = { id: string; name: string; scopes: string[]; company_scope: string[] | null };

declare module "fastify" {
  interface FastifyRequest {
    client?: ApiClient;
  }
}

const cache = new Map<string, { client: ApiClient | null; at: number }>();

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) return reply.code(401).send({ error: "Falta a chave da API (Authorization: Bearer ...)." });
  const hash = sha256(key);
  const hit = cache.get(hash);
  let client = hit && Date.now() - hit.at < 60_000 ? hit.client : undefined;
  if (client === undefined) {
    const [row] = await db()<ApiClient[]>`
      update public.api_clients set last_used_at = now()
      where key_hash = ${hash} and active
      returning id, name, scopes, company_scope`;
    client = row ?? null;
    cache.set(hash, { client, at: Date.now() });
  }
  if (!client) return reply.code(401).send({ error: "Chave da API inválida." });
  req.client = client;
}

/** A chave pode estar limitada a algumas empresas do MakeCRM. */
export function canCompany(req: FastifyRequest, companyId: string) {
  const scope = req.client?.company_scope;
  return !scope || scope.includes(companyId);
}
