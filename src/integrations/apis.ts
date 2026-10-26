import { db } from "../db.js";
import type { ToolDef } from "../llm/client.js";
import { log } from "../log.js";
import { assertPublicUrl } from "../net.js";
import { unseal } from "../secrets.js";
import type { AgentSpec } from "../spec/agent.js";
import { API_TOOL_PREFIX, apiToolName, type ApiParamT, type ExternalApiT } from "../spec/apis.js";
import type { ActionDebug } from "./debug.js";

/**
 * APIs externas: cada API configurada vira a ferramenta api_<id>. O motor monta
 * a chamada (caminho, URL, cabeçalhos, corpo e a chave do cofre), chama só
 * endereços públicos e devolve ao agente a parte da resposta que interessa.
 * Na aba Testar, as consultas vão de verdade; as que enviam dados, não.
 */

export class ApiCallError extends Error {
  constructor(
    readonly code: "api_auth" | "api_not_found" | "api_rejected" | "api_server" | "api_timeout" | "api_network" | "api_no_key" | "api_invalid",
    message: string,
  ) {
    super(message);
  }
}

export const API_FIX: Record<string, string> = {
  api_auth: "A API recusou a chave: confira a chave em Integrações › APIs externas (ou se ela expirou).",
  api_not_found: "O endereço não existe na API (404): confira o endereço e os campos do caminho.",
  api_rejected: "A API recusou os dados enviados: confira os campos (nome, formato) em Dados da chamada e use Testar chamada.",
  api_server: "A API do cliente está com erro do lado dela; se continuar, avise o responsável pelo sistema.",
  api_timeout: "A API demorou demais para responder: aumente o tempo limite ou fale com o responsável pelo sistema.",
  api_network: "Não foi possível conectar ao endereço: confira se ele está certo e no ar.",
  api_no_key: "Falta salvar a chave de acesso desta API.",
  api_invalid: "A configuração da API tem um problema: abra a API em Integrações e use Testar chamada.",
};

const enabledApis = (spec: AgentSpec) => (spec.apis ?? []).filter((a) => a.enabled);
export const isApiTool = (name: string) => name.startsWith(API_TOOL_PREFIX);
export const apiOf = (spec: AgentSpec, tool: string) => enabledApis(spec).find((a) => apiToolName(a.id) === tool);

// ---------------------------------------------------------------- ferramentas

/** O nome do argumento que o modelo vê (sem pontos; repete o "onde" se dois campos tiverem o mesmo nome). */
export function argKeys(api: ExternalApiT): Map<ApiParamT, string> {
  const keys = new Map<ApiParamT, string>();
  const used = new Set<string>();
  for (const p of api.params) {
    if (p.source !== "agent") continue;
    let k = p.name.replace(/[^A-Za-z0-9_]/g, "_");
    if (used.has(k)) k = `${k}_${p.in}`;
    used.add(k);
    keys.set(p, k);
  }
  return keys;
}

const JSON_TYPE: Record<ApiParamT["type"], string> = { string: "string", number: "number", integer: "integer", boolean: "boolean" };

export function apiTools(spec: AgentSpec): ToolDef[] {
  return enabledApis(spec).map((api) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [p, k] of argKeys(api)) {
      properties[k] = {
        type: JSON_TYPE[p.type],
        ...(p.description ? { description: p.description } : {}),
        ...(p.options.length && p.type === "string" ? { enum: p.options } : {}),
      };
      if (p.required) required.push(k);
    }
    if (api.kind === "write") {
      properties.confirmado_pelo_lead = {
        type: "boolean",
        description: "true só depois de o lead confirmar, nesta conversa, os dados que vão ser enviados.",
      };
      required.push("confirmado_pelo_lead");
    }
    const how =
      api.kind === "write"
        ? "Esta ação ENVIA dados para outro sistema: antes, mostre ao lead o que vai ser enviado e peça confirmação; só chame depois do sim, com confirmado_pelo_lead=true."
        : "Consulta dados em outro sistema da empresa. Use a resposta em vez de supor; não invente o que ela não trouxer.";
    return {
      type: "function",
      function: {
        name: apiToolName(api.id),
        description: `${api.name}. Quando usar: ${api.when}\n${how}`,
        parameters: { type: "object", properties, required },
      },
    } satisfies ToolDef;
  });
}

// ---------------------------------------------------------------- valores

export type ContactInfo = { phone: string | null; contactName: string | null; facts: Record<string, unknown> };

/** O valor de cada campo: do agente, fixo ou do contato. Os que faltam vêm em `missing`. */
export function resolveValues(
  api: ExternalApiT,
  args: Record<string, unknown>,
  contact: ContactInfo,
): { values: Map<ApiParamT, string | number | boolean>; missing: string[] } {
  const keys = argKeys(api);
  const values = new Map<ApiParamT, string | number | boolean>();
  const missing: string[] = [];
  for (const p of api.params) {
    let raw: unknown;
    if (p.source === "fixed") raw = p.value;
    else if (p.source === "contact") {
      if (p.value === "phone") raw = contact.phone;
      else if (p.value === "name") raw = contact.contactName;
      else raw = contact.facts[p.value.slice(5)];
    } else raw = args[keys.get(p)!];
    const v = coerce(raw, p.type);
    if (v === null) {
      if (p.required) missing.push(p.description || p.name);
      continue;
    }
    values.set(p, v);
  }
  return { values, missing };
}

function coerce(raw: unknown, type: ApiParamT["type"]): string | number | boolean | null {
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : raw;
  if (s === "") return null;
  if (type === "boolean") {
    if (typeof s === "boolean") return s;
    const t = String(s).toLowerCase();
    return ["true", "1", "sim", "yes"].includes(t) ? true : ["false", "0", "não", "nao", "no"].includes(t) ? false : null;
  }
  if (type === "number" || type === "integer") {
    const n = typeof s === "number" ? s : Number(String(s).replace(",", "."));
    if (!Number.isFinite(n)) return null;
    return type === "integer" ? Math.trunc(n) : n;
  }
  return typeof s === "object" ? JSON.stringify(s) : String(s).slice(0, 4000);
}

// ---------------------------------------------------------------- a chamada

export type BuiltRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** Para mostrar (Registro técnico, Testar chamada): a chave aparece mascarada. */
  preview: { method: string; url: string; headers: Record<string, string>; body: unknown };
};

const mask = (secret: string) => (secret.length > 8 ? `••••${secret.slice(-4)}` : "••••");

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export function buildRequest(api: ExternalApiT, values: Map<ApiParamT, string | number | boolean>, secret: string | null): BuiltRequest {
  if (api.auth.type !== "none" && !secret) throw new ApiCallError("api_no_key", `A API "${api.name}" precisa da chave de acesso, que ainda não foi salva.`);
  let path = api.url;
  for (const [p, v] of values) if (p.in === "path") path = path.split(`{${p.name}}`).join(encodeURIComponent(String(v)));
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    throw new ApiCallError("api_invalid", "Endereço da API inválido.");
  }
  const headers: Record<string, string> = { "user-agent": "MAVI-Agentes/1.0", accept: "application/json, text/plain;q=0.9, */*;q=0.5" };
  const shown: Record<string, string> = {};
  for (const h of api.headers) headers[h.name.toLowerCase()] = shown[h.name] = h.value;
  const body: Record<string, unknown> = {};
  let hasBody = false;
  for (const [p, v] of values) {
    if (p.in === "query") url.searchParams.set(p.name, String(v));
    else if (p.in === "header") headers[p.name.toLowerCase()] = shown[p.name] = String(v);
    else if (p.in === "body") {
      setPath(body, p.name, v);
      hasBody = true;
    }
  }
  const previewUrl = new URL(url);
  if (secret) {
    if (api.auth.type === "bearer") {
      headers.authorization = `Bearer ${secret}`;
      shown.Authorization = `Bearer ${mask(secret)}`;
    } else if (api.auth.type === "basic") {
      headers.authorization = `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
      shown.Authorization = `Basic ${mask(secret)}`;
    } else if (api.auth.type === "header") {
      headers[api.auth.name.toLowerCase()] = secret;
      shown[api.auth.name] = mask(secret);
    } else if (api.auth.type === "query") {
      url.searchParams.set(api.auth.name, secret);
      previewUrl.searchParams.set(api.auth.name, mask(secret));
    }
  }
  let payload: string | undefined;
  // POST/PUT/PATCH sempre levam corpo (mesmo vazio); GET/DELETE só se houver campo no corpo.
  if (hasBody || (api.method !== "GET" && api.method !== "DELETE")) {
    if (api.body_format === "form") {
      const form = new URLSearchParams();
      for (const [p, v] of values) if (p.in === "body") form.set(p.name, String(v));
      payload = form.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else {
      payload = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    shown["Content-Type"] = headers["content-type"];
  }
  return {
    method: api.method,
    url: url.toString(),
    headers,
    body: payload,
    preview: { method: api.method, url: previewUrl.toString(), headers: shown, body: payload === undefined ? null : api.body_format === "form" ? payload : body },
  };
}

export type ApiResponse = { status: number; ms: number; text: string; json: unknown; truncated: boolean };

const MAX_RESPONSE_BYTES = 512 * 1024;

export async function sendRequest(req: BuiltRequest, timeoutSeconds: number): Promise<ApiResponse> {
  const started = Date.now();
  let current = req.url;
  let method = req.method;
  let body = req.body;
  for (let hop = 0; hop < 4; hop++) {
    let url: URL;
    try {
      url = await assertPublicUrl(current);
    } catch (e) {
      throw new ApiCallError("api_invalid", e instanceof Error ? e.message : "Endereço não aceito.");
    }
    let res: Response;
    try {
      res = await fetch(url, { method, headers: req.headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutSeconds * 1000) });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new ApiCallError(timeout ? "api_timeout" : "api_network", timeout ? `A API não respondeu em ${timeoutSeconds} s.` : "Não foi possível conectar à API.");
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      // Redirecionamento: só GET segue com o mesmo pedido; 303 vira GET sem corpo.
      if (res.status === 303) {
        method = "GET";
        body = undefined;
      } else if (method !== "GET") throw new ApiCallError("api_invalid", `A API redirecionou (${res.status}) para ${location}: use o endereço final.`);
      current = new URL(location, url).toString();
      continue;
    }
    const { text, truncated } = await readLimited(res);
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ms: Date.now() - started, text, json, truncated };
  }
  throw new ApiCallError("api_invalid", "A API redirecionou vezes demais.");
}

async function readLimited(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    parts.push(value);
  }
  return { text: Buffer.concat(parts).toString("utf8"), truncated };
}

/** Erro HTTP → o motivo (para o alerta e o que ajustar). */
export function statusError(status: number, text: string): ApiCallError {
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 300);
  const msg = `A API respondeu ${status}${detail ? `: ${detail}` : ""}`;
  if (status === 401 || status === 403) return new ApiCallError("api_auth", msg);
  if (status === 404) return new ApiCallError("api_not_found", msg);
  if (status >= 500) return new ApiCallError("api_server", msg);
  return new ApiCallError("api_rejected", msg);
}

// ---------------------------------------------------------------- a resposta

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      // itens.preco em lista: o campo de cada item.
      if (/^\d+$/.test(k)) cur = cur[Number(k)];
      else cur = cur.map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined));
    } else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

/** A parte da resposta que vai para o agente: os caminhos escolhidos (ou tudo), compacta e limitada. */
export function shapeResponse(api: ExternalApiT, res: Pick<ApiResponse, "json" | "text">): string {
  let data: unknown = res.json ?? res.text;
  if (res.json !== null && api.response.pick.length) {
    const picked: Record<string, unknown> = {};
    for (const p of api.response.pick) {
      const v = getPath(res.json, p);
      if (v !== undefined) picked[p] = v;
    }
    data = picked;
  }
  const out = typeof data === "string" ? data.replace(/\s+/g, " ").trim() : JSON.stringify(data);
  const max = api.response.max_chars;
  return out.length > max ? `${out.slice(0, max)}… (cortado)` : out;
}

// ---------------------------------------------------------------- cofre

const secretCache = new Map<string, { key: string | null; at: number }>();

export async function apiSecret(agentId: string, apiId: string): Promise<string | null> {
  const k = `${agentId}:${apiId}`;
  const hit = secretCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.key;
  const [row] = await db()<{ key_cipher: string }[]>`
    select key_cipher from public.agent_api_secrets where agent_id = ${agentId} and api_id = ${apiId}`;
  let key: string | null = null;
  if (row)
    try {
      key = unseal(row.key_cipher);
    } catch {
      key = null;
    }
  secretCache.set(k, { key, at: Date.now() });
  return key;
}

export const forgetApiSecret = (agentId: string, apiId: string) => secretCache.delete(`${agentId}:${apiId}`);

// ---------------------------------------------------------------- uma chamada completa

export type ApiCallOutcome = {
  request: BuiltRequest["preview"];
  response: ApiResponse;
  result: string;
};

/** Monta, chama e resume. Erro HTTP vira ApiCallError (com o pedido para o rastro). */
export async function callApi(api: ExternalApiT, values: Map<ApiParamT, string | number | boolean>, secret: string | null): Promise<ApiCallOutcome> {
  const req = buildRequest(api, values, secret);
  const response = await sendRequest(req, api.timeout_seconds);
  if (response.status < 200 || response.status >= 300) {
    const err = statusError(response.status, response.text);
    (err as ApiCallError & { request?: unknown }).request = req.preview;
    throw err;
  }
  return { request: req.preview, response, result: shapeResponse(api, response) };
}

export type ApiToolCtx = ContactInfo & { agentId: string; simulation: boolean; spec: AgentSpec };
export type ApiToolResult = { result: string; debug: ActionDebug; failure?: ApiCallError };

export async function runApiTool(name: string, args: Record<string, unknown>, ctx: ApiToolCtx): Promise<ApiToolResult> {
  const api = apiOf(ctx.spec, name);
  if (!api) return { result: "Ferramenta não disponível.", debug: { outcome: "error", code: "api_invalid", summary: "API desligada ou removida." } };
  const { values, missing } = resolveValues(api, args, ctx);
  if (missing.length)
    return {
      result: `Faltam dados para chamar "${api.name}": ${missing.join(", ")}. Peça ao lead o que faltar (ou siga sem esta consulta).`,
      debug: { outcome: "empty", code: "api_missing", summary: `Faltaram: ${missing.join(", ")}` },
    };
  if (api.kind === "write" && args.confirmado_pelo_lead !== true)
    return {
      result: "Ainda não enviei. Mostre ao lead os dados que vão ser enviados, peça a confirmação e só depois chame de novo com confirmado_pelo_lead=true.",
      debug: { outcome: "blocked", code: "api_needs_confirmation", summary: "Esperando o lead confirmar o envio." },
    };
  let secret: string | null = null;
  try {
    secret = api.auth.type === "none" ? null : await apiSecret(ctx.agentId, api.id);
    if (api.kind === "write" && ctx.simulation) {
      const req = buildRequest(api, values, secret);
      return {
        result: `(Teste: nada foi enviado de verdade.) No ar, enviaria para "${api.name}": ${JSON.stringify(req.preview.body ?? req.preview.url).slice(0, 1500)}. Continue a conversa como se o envio tivesse dado certo.`,
        debug: { outcome: "simulated", summary: `Enviaria ${req.preview.method} ${req.preview.url}`, details: [JSON.stringify(req.preview).slice(0, 1500)] },
      };
    }
    const out = await callApi(api, values, secret);
    const extra = api.response.instructions ? `\nComo usar: ${api.response.instructions}` : "";
    return {
      result: `Resposta de "${api.name}" (HTTP ${out.response.status}):\n${out.result}${extra}\nUse só o que está aqui; o que não veio, não invente.`,
      debug: {
        outcome: ctx.simulation ? "simulated" : "ok",
        summary: `${out.request.method} ${out.request.url} → ${out.response.status} em ${out.response.ms} ms`,
        details: [`Resposta usada: ${out.result.slice(0, 1200)}`],
      },
    };
  } catch (e) {
    const err = e instanceof ApiCallError ? e : new ApiCallError("api_network", e instanceof Error ? e.message : String(e));
    log.warn({ agent: ctx.agentId, api: api.id, code: err.code, err: err.message }, "api externa falhou");
    const request = (err as ApiCallError & { request?: BuiltRequest["preview"] }).request;
    return {
      result:
        api.kind === "write"
          ? `Não deu certo enviar para "${api.name}" (${err.message.slice(0, 200)}). Diga ao lead, com naturalidade, que a equipe vai concluir e retornar; não diga que deu certo.`
          : `Não consegui consultar "${api.name}" agora. Não invente a informação: diga que vai confirmar e retornar, ou siga com o que já sabe.`,
      debug: {
        outcome: "error",
        code: err.code,
        summary: err.message.slice(0, 500),
        ...(request ? { details: [`${request.method} ${request.url}`] } : {}),
        hint: API_FIX[err.code],
      },
      failure: err,
    };
  }
}

// ---------------------------------------------------------------- no começo da conversa

export type StartContext = Record<string, { at: string; name: string; text?: string; error?: string }>;

/**
 * As APIs marcadas para o começo da conversa que ainda não rodaram nesta
 * conversa (zerar a memória roda de novo). O que voltar vira contexto.
 */
export async function runStartApis(
  spec: AgentSpec,
  conv: { id: string; agent_id: string; api_context?: StartContext | null } & ContactInfo,
): Promise<{ context: StartContext; debug: { name: string; result: string; debug: ActionDebug }[] }> {
  const context: StartContext = { ...(conv.api_context ?? {}) };
  const debug: { name: string; result: string; debug: ActionDebug }[] = [];
  const todo = enabledApis(spec).filter((a) => a.on_start && a.kind === "read" && !context[a.id]);
  if (!todo.length) return { context, debug };
  await Promise.all(
    todo.map(async (api) => {
      const { values, missing } = resolveValues(api, {}, conv);
      if (missing.length) {
        // Sem o dado do contato ainda (ex.: e-mail): tenta de novo na próxima mensagem.
        debug.push({ name: apiToolName(api.id), result: "faltam dados", debug: { outcome: "empty", code: "api_missing", summary: `Começo da conversa: faltaram ${missing.join(", ")}` } });
        return;
      }
      try {
        const secret = api.auth.type === "none" ? null : await apiSecret(conv.agent_id, api.id);
        const out = await callApi(api, values, secret);
        context[api.id] = { at: new Date().toISOString(), name: api.name, text: out.result + (api.response.instructions ? ` (Como usar: ${api.response.instructions})` : "") };
        debug.push({ name: apiToolName(api.id), result: out.result.slice(0, 2000), debug: { outcome: "ok", summary: `Começo da conversa: ${out.request.method} ${out.request.url} → ${out.response.status}` } });
      } catch (e) {
        const err = e instanceof ApiCallError ? e : new ApiCallError("api_network", String(e));
        context[api.id] = { at: new Date().toISOString(), name: api.name, error: err.message.slice(0, 300) };
        debug.push({ name: apiToolName(api.id), result: err.message, debug: { outcome: "error", code: err.code, summary: `Começo da conversa: ${err.message.slice(0, 400)}`, hint: API_FIX[err.code] } });
      }
    }),
  );
  await db()`update public.conversations set api_context = ${db().json(context as never)} where id = ${conv.id}`;
  return { context, debug };
}

/** As linhas de contexto das APIs do começo (só as que deram certo). */
export function startContextLines(context: StartContext): string[] {
  return Object.values(context)
    .filter((c) => c.text)
    .map((c) => `${c.name}: ${c.text}`);
}
