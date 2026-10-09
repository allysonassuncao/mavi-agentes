-- Falhas das integrações nas conversas reais (Google Agenda, MakeCRM, aviso à
-- equipe): o construtor mostra o alerta e a equipe é avisada (no máximo uma
-- vez a cada 6 horas por agente, integração e motivo).
create table public.integration_failures (
  id bigint generated always as identity primary key,
  agent_id uuid not null references public.agents (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  integration text not null,
  tool text not null,
  code text not null default 'error',
  message text not null default '' check (length(message) <= 2000),
  notified boolean not null default false,
  created_at timestamptz not null default now()
);
create index integration_failures_agent on public.integration_failures (agent_id, created_at desc);
alter table public.integration_failures enable row level security;
revoke all on public.integration_failures from anon, authenticated;
