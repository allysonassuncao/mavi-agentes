-- Integrações dos agentes (Fase 2).

-- Rodízio (Google Agenda e responsáveis): quantas vezes cada usuário foi
-- escolhido em cada regra; zera quando todos chegam ao peso.
create table public.integration_rotation (
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- "calendar" ou "<id da regra>:<papel>".
  rotation_key text not null check (length(rotation_key) between 1 and 120),
  user_id text not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (agent_id, rotation_key, user_id)
);

-- Reuniões que os agentes marcaram (para remarcar e cancelar a certa).
create table public.agent_meetings (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  company_id text not null,
  host_user_id text not null,
  calendar_id text not null,
  event_id text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  link text,
  attendee_email text,
  status text not null default 'scheduled' check (status in ('scheduled', 'canceled')),
  deal_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agent_meetings_conversation on public.agent_meetings (conversation_id, starts_at desc);

do $$
declare t text;
begin
  foreach t in array array['integration_rotation', 'agent_meetings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
