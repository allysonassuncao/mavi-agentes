-- Régua de follow-up: em que etapa cada conversa está e quando sai a próxima.
alter table public.conversations
  add column followup_step integer not null default 0,
  add column followup_next_at timestamptz,
  add column followup_state text not null default 'idle' check (followup_state in ('idle', 'active', 'done'));
create index conversations_followup_due on public.conversations (followup_next_at) where followup_next_at is not null;

-- De onde veio a mensagem do agente (ex.: {"followup": 2}).
alter table public.messages add column meta jsonb;
