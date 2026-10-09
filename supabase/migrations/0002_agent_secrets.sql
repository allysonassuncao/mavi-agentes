-- Chaves de API próprias de cada agente (OpenRouter, OpenAI, Anthropic…),
-- cifradas com AES-256-GCM (SECRETS_KEY do motor). Nunca voltam pela API:
-- só os 4 últimos caracteres.
create table public.agent_secrets (
  agent_id uuid not null references public.agents (id) on delete cascade,
  provider text not null check (provider in ('openrouter', 'openai', 'anthropic', 'google', 'deepseek', 'groq', 'mistral', 'xai')),
  key_cipher text not null check (key_cipher ~ '^v1:'),
  key_hint text not null default '',
  -- Última conferência com o provedor (botão Testar): ok, erro e quando.
  checked_at timestamptz,
  check_ok boolean,
  check_error text,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (agent_id, provider)
);
alter table public.agent_secrets enable row level security;
revoke all on public.agent_secrets from anon, authenticated;
