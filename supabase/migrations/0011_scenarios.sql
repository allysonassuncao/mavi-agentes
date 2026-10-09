-- Cenários combinados ("quando o lead pedir X, faça Y"): cada vez que o
-- agente aciona um, o que foi feito (para a aba Cenários do construtor).
create table public.scenario_runs (
  id bigint generated always as identity primary key,
  agent_id uuid not null references public.agents (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  turn_id uuid,
  scenario_id text not null,
  scenario_name text not null default '',
  reason text not null default '' check (length(reason) <= 500),
  actions jsonb not null default '[]',
  simulation boolean not null default false,
  created_at timestamptz not null default now()
);
create index scenario_runs_agent on public.scenario_runs (agent_id, created_at desc);
alter table public.scenario_runs enable row level security;
revoke all on public.scenario_runs from anon, authenticated;
