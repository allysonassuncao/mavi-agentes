import { config } from "../config.js";

/**
 * Cliente mínimo para APIs compatíveis com a OpenAI (OpenRouter e OpenAI).
 * Modelos com "/" (ex.: "openai/gpt-5.2") vão pelo OpenRouter, que devolve o
 * custo de cada chamada; sem "/", direto na OpenAI.
 */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type Usage = { tokensIn: number; tokensOut: number; tokensCached: number; costUsd: number };
export const emptyUsage = (): Usage => ({ tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 });
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    tokensCached: a.tokensCached + b.tokensCached,
    costUsd: a.costUsd + b.costUsd,
  };
}

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: "auto" | "required" | "none";
  temperature?: number | null;
  effort?: "low" | "medium" | "high" | null;
  maxTokens?: number;
  /** Resposta em JSON (para tarefas de apoio). */
  json?: boolean;
  timeoutMs?: number;
};

export type ChatResponse = {
  message: { content: string | null; tool_calls?: ToolCall[] };
  usage: Usage;
  model: string;
  finishReason: string | null;
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function endpoint(model: string) {
  const c = config();
  if (model.includes("/") && c.OPENROUTER_API_KEY) {
    return { base: "https://openrouter.ai/api/v1", key: c.OPENROUTER_API_KEY, model, openrouter: true };
  }
  if (!c.OPENAI_API_KEY) throw new LlmError("Nenhuma chave de LLM configurada (OPENROUTER_API_KEY/OPENAI_API_KEY).", 0, false);
  return { base: "https://api.openai.com/v1", key: c.OPENAI_API_KEY, model: model.replace(/^openai\//, ""), openrouter: false };
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const ep = endpoint(req.model);
  const body: Record<string, unknown> = {
    model: ep.model,
    messages: req.messages,
  };
  if (req.tools?.length) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? "auto";
  }
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.maxTokens) body[ep.openrouter ? "max_tokens" : "max_completion_tokens"] = req.maxTokens;
  if (req.json) body.response_format = { type: "json_object" };
  if (ep.openrouter) {
    body.usage = { include: true };
    if (req.effort) body.reasoning = { effort: req.effort };
  } else if (req.effort && /^(gpt-5|o\d)/.test(ep.model)) {
    body.reasoning_effort = req.effort;
  }

  const res = await fetch(`${ep.base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ep.key}`,
      "content-type": "application/json",
      ...(ep.openrouter ? { "x-title": "MAVI Agentes", "http-referer": "https://agentes.maso.app.br" } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeoutMs ?? 90_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new LlmError(`LLM ${res.status}: ${raw.slice(0, 500)}`, res.status, retryable);
  }
  const j = JSON.parse(raw) as {
    model?: string;
    error?: { message?: string; code?: number };
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string | null }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  // O OpenRouter às vezes devolve 200 com erro do provedor no corpo.
  if (j.error) throw new LlmError(`LLM: ${j.error.message ?? "erro"}`, j.error.code ?? 502, true);
  const choice = j.choices?.[0];
  if (!choice?.message) throw new LlmError("LLM: resposta sem mensagem", 502, true);
  return {
    message: { content: choice.message.content ?? null, tool_calls: choice.message.tool_calls },
    usage: {
      tokensIn: j.usage?.prompt_tokens ?? 0,
      tokensOut: j.usage?.completion_tokens ?? 0,
      tokensCached: j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      costUsd: j.usage?.cost ?? 0,
    },
    model: j.model ?? req.model,
    finishReason: choice.finish_reason ?? null,
  };
}

/** Uma nova tentativa no mesmo modelo para erros passageiros; depois o modelo reserva. */
export async function chatWithFallback(req: ChatRequest, fallbackModel: string | null): Promise<ChatResponse> {
  try {
    return await chat(req);
  } catch (e) {
    if (!(e instanceof LlmError) || !e.retryable) throw e;
    await new Promise((r) => setTimeout(r, 800));
    try {
      return await chat(req);
    } catch (e2) {
      if (!fallbackModel || fallbackModel === req.model) throw e2;
      return await chat({ ...req, model: fallbackModel });
    }
  }
}

// ---------------------------------------------------------------- vetores

export const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_USD_PER_M: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
};

export async function embed(texts: string[]): Promise<{ vectors: number[][]; usage: Usage; model: string }> {
  const c = config();
  if (!texts.length) return { vectors: [], usage: emptyUsage(), model: c.EMBEDDING_MODEL };
  if (!c.OPENAI_API_KEY) throw new LlmError("OPENAI_API_KEY não configurada (vetores).", 0, false);
  const vectors: number[][] = [];
  let tokens = 0;
  // Lotes de 96 textos (limite confortável da API).
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96).map((t) => t.slice(0, 24_000) || " ");
    let attempt = 0;
    for (;;) {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${c.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: c.EMBEDDING_MODEL, input: batch, dimensions: EMBEDDING_DIMENSIONS }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const j = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
        for (const d of [...j.data].sort((a, b) => a.index - b.index)) vectors.push(d.embedding);
        tokens += j.usage?.total_tokens ?? 0;
        break;
      }
      if ((res.status === 429 || res.status >= 500) && attempt++ < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw new LlmError(`Vetores ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, false);
    }
  }
  const usd = ((EMBEDDING_USD_PER_M[c.EMBEDDING_MODEL] ?? 0.02) * tokens) / 1e6;
  return { vectors, usage: { tokensIn: tokens, tokensOut: 0, tokensCached: 0, costUsd: usd }, model: c.EMBEDDING_MODEL };
}

// ---------------------------------------------------------------- transcrição

export async function transcribe(audio: Blob, filename: string): Promise<string> {
  const c = config();
  if (!c.OPENAI_API_KEY) throw new LlmError("OPENAI_API_KEY não configurada (transcrição).", 0, false);
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", c.TRANSCRIBE_MODEL);
  form.append("language", "pt");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${c.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new LlmError(`Transcrição ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500);
  const j = (await res.json()) as { text?: string };
  return (j.text ?? "").trim();
}
