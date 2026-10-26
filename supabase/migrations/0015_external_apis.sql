-- APIs externas do agente: a chave de acesso de cada API (por código da API),
-- cifrada com SECRETS_KEY. Nunca volta pela API: só os 4 últimos caracteres.
create table public.agent_api_secrets (
  agent_id uuid not null references public.agents (id) on delete cascade,
  api_id text not null check (api_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  key_cipher text not null check (key_cipher ~ '^v1:'),
  key_hint text not null default '',
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (agent_id, api_id)
);
alter table public.agent_api_secrets enable row level security;
revoke all on public.agent_api_secrets from anon, authenticated;

-- O que as APIs "no começo da conversa" trouxeram: {<api_id>: {at, text, error}}.
alter table public.conversations add column api_context jsonb not null default '{}' check (jsonb_typeof(api_context) = 'object');
