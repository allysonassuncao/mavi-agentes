-- Chat do site: cada visitante (pela chave guardada no navegador dele) e a
-- conversa dele na caixa "Chat do site" do MakeCRM. A chave do visitante é o
-- segredo: só o hash fica aqui.
create table public.webchat_sessions (
  id uuid primary key default gen_random_uuid(),
  inbox_id text not null check (length(inbox_id) between 1 and 64),
  company_id text not null,
  visitor_hash text not null unique,
  -- Conversa no MakeCRM (inbox_conversations.id), criada na primeira mensagem.
  makecrm_conversation_id text,
  contact_name text,
  phone text,
  email text,
  page_url text,
  referrer text,
  utm jsonb not null default '{}' check (jsonb_typeof(utm) = 'object'),
  -- O MakeCRM já tem o contato (e a oportunidade, se configurada).
  lead_synced_at timestamptz,
  -- "Continuar no WhatsApp": o código que vai na mensagem para ligar as duas conversas.
  wa_code text unique,
  wa_used_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index webchat_sessions_conversation on public.webchat_sessions (makecrm_conversation_id) where makecrm_conversation_id is not null;
create index webchat_sessions_inbox on public.webchat_sessions (inbox_id, last_seen_at desc);
alter table public.webchat_sessions enable row level security;
revoke all on public.webchat_sessions from anon, authenticated;

-- O canal da ligação: WhatsApp (o Go chama o motor) ou chat do site (o motor recebe direto).
alter table public.bindings add column channel text not null default 'whatsapp' check (channel in ('whatsapp', 'webchat'));
