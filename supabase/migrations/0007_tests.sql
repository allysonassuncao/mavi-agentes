-- Testes com leads simulados (Fase 5): uma bateria de conversas entre o agente
-- e leads simulados pela MAVI (perfis variados), cada conversa avaliada; as
-- lacunas encontradas entram nas Lacunas com origem "teste".

create table public.test_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- manual (sob demanda), publish (antes de publicar) ou scheduled (periódica).
  kind text not null check (kind in ('manual', 'publish', 'scheduled')),
  -- O que foi testado: a versão (null = rascunho) e a especificação usada.
  agent_version integer,
  spec jsonb not null,
  -- Bateria "antes de publicar": o par (a mesma bateria na versão publicada).
  compare_to uuid references public.test_runs (id) on delete set null,
  profiles text[] not null default '{}',
  focus text not null default '' check (length(focus) <= 1000),
  personas jsonb not null default '[]',
  conversations integer not null check (conversations between 1 and 50),
  max_turns integer not null check (max_turns between 2 and 20),
  cost_cap_usd numeric(10, 4) not null check (cost_cap_usd > 0),
  cost_usd numeric(12, 6) not null default 0,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'stopped', 'error')),
  stop_reason text,
  -- {score, goal_rate, outcomes, issues, gaps, conclusion, actions}
  summary jsonb,
  error text,
  created_by text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index test_runs_agent on public.test_runs (agent_id, created_at desc);

create table public.test_conversations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.test_runs (id) on delete cascade,
  idx integer not null,
  persona jsonb not null,
  conversation_id uuid references public.conversations (id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error', 'skipped')),
  turns integer not null default 0,
  -- {score, goal_reached, outcome, issues[], gaps[], strengths[], summary}
  verdict jsonb,
  cost_usd numeric(12, 6) not null default 0,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, idx)
);

-- Lacunas achadas nos testes (o mesmo tema das reais; a cobertura só conta as reais).
alter table public.gaps add column origin text not null default 'live' check (origin in ('live', 'test'));

do $$
declare t text;
begin
  foreach t in array array['test_runs', 'test_conversations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
