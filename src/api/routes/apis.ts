import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { ApiCallError, API_FIX, apiSecret, buildRequest, credential, forgetApiSecret, parseOAuthSecret, resolveValues, responseMedia, sendRequest, shapeResponse, statusError } from "../../integrations/apis.js";
import { seal, SecretsError } from "../../secrets.js";
import { ExternalApi } from "../../spec/apis.js";
import { HttpError, parseBody } from "../http.js";
import { loadAgent } from "./agents.js";

/**
 * APIs externas: a chave de acesso de cada API (entra e nunca mais sai; a API
 * devolve só o final) e o "Testar chamada" do construtor, que chama a API de
 * verdade com a configuração do rascunho.
 */

const apiId = (v: string) => {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(v)) throw new HttpError(400, "Código da API inválido.");
  return v;
};

/** Os caminhos das folhas de um JSON (listas pelo primeiro item, sem o índice), para escolher o que guardar. */
export function jsonPaths(v: unknown, prefix = "", out: string[] = [], depth = 0): string[] {
  if (out.length >= 200 || depth > 8) return out;
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === "object" && v[0] !== null) jsonPaths(v[0], prefix, out, depth + 1);
    else if (prefix) out.push(prefix);
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (x && typeof x === "object") jsonPaths(x, p, out, depth + 1);
      else out.push(p);
      if (out.length >= 200) break;
    }
    return out;
  }
  if (prefix) out.push(prefix);
  return out;
}

const TestBody = z.object({
  api: z.unknown(),
  /** Valores dos campos que o agente preencheria (pelo nome do argumento). */
  args: z.record(z.string(), z.unknown()).default({}),
  /** Contato de exemplo para os campos "do contato". */
  contact: z
    .object({ phone: z.string().max(40).nullable().default(null), name: z.string().max(120).nullable().default(null), facts: z.record(z.string(), z.unknown()).default({}) })
    .default({ phone: null, name: null, facts: {} }),
  /** Chave ainda não salva (para testar antes de salvar). */
  key: z.string().trim().max(2000).optional(),
});

export async function apiRoutes(app: FastifyInstance) {
  app.get("/v1/agents/:id/api-secrets", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const secrets = await db()`
      select api_id, key_hint, updated_by, updated_at from public.agent_api_secrets where agent_id = ${a.id} order by api_id`;
    return { secrets };
  });

  app.put("/v1/agents/:id/api-secrets/:api", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const id = apiId((req.params as { api: string }).api);
    const body = parseBody(z.object({ key: z.string().trim().min(1).max(2000), updated_by: z.string().max(200).optional() }), req.body);
    let cipher: string;
    try {
      cipher = seal(body.key);
    } catch (e) {
      if (e instanceof SecretsError) throw new HttpError(503, e.message);
      throw e;
    }
    // Login OAuth: o final do usuário (ou do id do cliente), nunca da senha.
    const oauth = parseOAuthSecret(body.key);
    const shown = oauth ? oauth.username || oauth.client_id : body.key;
    const hint = shown.length > 8 ? shown.slice(-4) : "";
    await db()`
      insert into public.agent_api_secrets (agent_id, api_id, key_cipher, key_hint, updated_by)
      values (${a.id}, ${id}, ${cipher}, ${hint}, ${body.updated_by ?? req.client!.name})
      on conflict (agent_id, api_id) do update set
        key_cipher = excluded.key_cipher, key_hint = excluded.key_hint, updated_by = excluded.updated_by, updated_at = now()`;
    forgetApiSecret(a.id, id);
    return { api_id: id, key_hint: hint };
  });

  app.delete("/v1/agents/:id/api-secrets/:api", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const id = apiId((req.params as { api: string }).api);
    await db()`delete from public.agent_api_secrets where agent_id = ${a.id} and api_id = ${id}`;
    forgetApiSecret(a.id, id);
    return { ok: true };
  });

  /** Testar chamada: monta e chama a API do rascunho (inclusive as que enviam dados: quem testa decide). */
  app.post("/v1/agents/:id/apis/test", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(TestBody, req.body);
    const parsed = ExternalApi.safeParse(body.api);
    if (!parsed.success)
      throw new HttpError(400, "Confira a configuração da API.", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const api = parsed.data;
    const { values, missing } = resolveValues(api, body.args, { phone: body.contact.phone, contactName: body.contact.name, facts: body.contact.facts });
    if (missing.length) throw new HttpError(400, `Preencha para testar: ${missing.join(", ")}.`);
    const secret = api.auth.type === "none" ? null : body.key || (await apiSecret(a.id, api.id));
    let preview: ReturnType<typeof buildRequest>["preview"] | null = null;
    try {
      let built = buildRequest(api, values, await credential(api, secret));
      preview = built.preview;
      let res = await sendRequest(built, api.timeout_seconds);
      if (api.auth.type === "oauth2" && res.status === 401) {
        built = buildRequest(api, values, await credential(api, secret, true));
        res = await sendRequest(built, api.timeout_seconds);
      }
      const ok = res.status >= 200 && res.status < 300;
      const err = ok ? null : statusError(res.status, res.text);
      return {
        ok,
        request: preview,
        status: res.status,
        ms: res.ms,
        response: res.text.slice(0, 20_000),
        truncated: res.truncated || res.text.length > 20_000,
        paths: res.json !== null ? jsonPaths(res.json) : [],
        result: ok ? shapeResponse(api, res, values) : null,
        media: ok ? responseMedia(api, res.json, values) : [],
        error: err?.message ?? null,
        code: err?.code ?? null,
        hint: err ? API_FIX[err.code] : null,
      };
    } catch (e) {
      const err = e instanceof ApiCallError ? e : new ApiCallError("api_network", e instanceof Error ? e.message : String(e));
      return { ok: false, request: preview, status: null, ms: null, response: "", truncated: false, paths: [], result: null, media: [], error: err.message, code: err.code, hint: API_FIX[err.code] };
    }
  });
}
