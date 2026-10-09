/**
 * Provedores de LLM que o motor fala (todos pela API de chat no formato da
 * OpenAI). A referência do modelo é "<provedor>:<modelo>"
 * (ex.: "openrouter:openai/gpt-5.2", "anthropic:claude-sonnet-4-6"); sem
 * prefixo conhecido vale o formato antigo: com "/" é OpenRouter, sem é OpenAI.
 */

export const PROVIDERS = {
  openrouter: { label: "OpenRouter", base: "https://openrouter.ai/api/v1", effort: "openrouter" },
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", effort: "openai" },
  anthropic: { label: "Anthropic (Claude)", base: "https://api.anthropic.com/v1", effort: null },
  google: { label: "Google (Gemini)", base: "https://generativelanguage.googleapis.com/v1beta/openai", effort: "openai" },
  deepseek: { label: "DeepSeek", base: "https://api.deepseek.com/v1", effort: null },
  groq: { label: "Groq", base: "https://api.groq.com/openai/v1", effort: null },
  mistral: { label: "Mistral", base: "https://api.mistral.ai/v1", effort: null },
  xai: { label: "xAI (Grok)", base: "https://api.x.ai/v1", effort: null },
} as const;

export type ProviderKind = keyof typeof PROVIDERS;
export const PROVIDER_KINDS = Object.keys(PROVIDERS) as ProviderKind[];
export const isProvider = (k: string): k is ProviderKind => k in PROVIDERS;

export type ModelRef = { kind: ProviderKind; model: string };

export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(":");
  if (i > 0) {
    const kind = ref.slice(0, i);
    if (isProvider(kind)) return { kind, model: ref.slice(i + 1) };
  }
  return ref.includes("/") ? { kind: "openrouter", model: ref } : { kind: "openai", model: ref.replace(/^openai\//, "") };
}

/** Preço em US$ por milhão de tokens (do Painel da MAVI), para provedores que não devolvem o custo. */
export type Pricing = { input: number; output: number; cached?: number | null };

export function costOf(p: Pricing | null | undefined, tokensIn: number, tokensOut: number, tokensCached: number) {
  if (!p) return 0;
  const cached = Math.min(tokensCached, tokensIn);
  return ((tokensIn - cached) * p.input + cached * (p.cached ?? p.input) + tokensOut * p.output) / 1e6;
}
