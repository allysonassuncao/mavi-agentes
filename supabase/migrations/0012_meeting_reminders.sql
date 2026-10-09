-- Régua de pré-reunião: o que já saiu (uma vez por reunião, etapa e horário
-- da reunião — remarcou, a régua vale de novo para o novo horário) e a
-- confirmação de presença pedida ao lead.
create table public.meeting_reminder_log (
  id bigint generated always as identity primary key,
  meeting_id uuid not null references public.agent_meetings (id) on delete cascade,
  step_id text not null,
  starts_at timestamptz not null,
  status text not null default 'sending' check (status in ('sending', 'sent', 'skipped', 'failed')),
  note text,
  turn_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (meeting_id, step_id, starts_at)
);
alter table public.meeting_reminder_log enable row level security;
revoke all on public.meeting_reminder_log from anon, authenticated;

alter table public.agent_meetings
  add column confirmation text not null default 'none' check (confirmation in ('none', 'asked', 'confirmed', 'declined')),
  add column confirmation_at timestamptz,
  add column confirmation_alerted boolean not null default false,
  -- Quando foi marcada (ou remarcada) para este horário: etapa que venceu antes disso não sai atrasada.
  add column scheduled_at timestamptz;
update public.agent_meetings set scheduled_at = coalesce(updated_at, created_at);
alter table public.agent_meetings alter column scheduled_at set default now(), alter column scheduled_at set not null;

create index agent_meetings_upcoming on public.agent_meetings (starts_at) where status = 'scheduled';
