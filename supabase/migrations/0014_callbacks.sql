-- Retornos combinados: o lead pede para ser chamado depois e o agente (ou a
-- pessoa, à mão) marca o dia e a hora. Na hora, o worker retoma a conversa e
-- faz as ações configuradas. Um retorno marcado por conversa; remarcar pelo
-- agente encerra o anterior (status canceled, motivo "remarcado") e abre outro
-- com seq + 1 (os adiamentos da conversa).
create table public.agent_callbacks (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sending', 'done', 'skipped', 'failed', 'canceled')),
  -- confirmed: o lead aceitou o dia e a hora; suggested: o agente propôs e o lead não respondeu.
  agreed text not null default 'confirmed' check (agreed in ('confirmed', 'suggested')),
  -- agent: o agente marcou na conversa; manual: uma pessoa marcou na aba Retornos.
  source text not null default 'agent' check (source in ('agent', 'manual')),
  -- O que o lead pediu e o que retomar.
  request text not null default '' check (length(request) <= 500),
  topic text not null default '' check (length(topic) <= 500),
  -- Quantos retornos o agente marcou nesta conversa até este (o 2º em diante é adiamento).
  seq int not null default 1,
  created_by text,
  simulation boolean not null default false,
  turn_id uuid,
  -- Na hora: a mensagem que saiu (ou o motivo de não ter saído) e as ações.
  sent_at timestamptz,
  done_turn_id uuid,
  outcome text,
  actions jsonb not null default '[]',
  -- Depois: o lead respondeu ou as ações de "sem resposta" rodaram.
  replied_at timestamptz,
  -- Quando rodam as ações de "sem resposta" (só com elas ligadas no envio) e quando rodaram.
  no_reply_due_at timestamptz,
  no_reply_at timestamptz,
  canceled_reason text,
  canceled_by text,
  -- Remarcações pela pessoa: [{at, from, to, by}].
  history jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index agent_callbacks_one_scheduled on public.agent_callbacks (conversation_id) where status = 'scheduled';
create index agent_callbacks_due on public.agent_callbacks (due_at) where status = 'scheduled' and not simulation;
create index agent_callbacks_agent on public.agent_callbacks (agent_id, due_at desc);
create index agent_callbacks_waiting on public.agent_callbacks (sent_at) where status = 'done' and replied_at is null and no_reply_at is null;
create index agent_callbacks_no_reply on public.agent_callbacks (no_reply_due_at) where replied_at is null and no_reply_at is null;
alter table public.agent_callbacks enable row level security;
revoke all on public.agent_callbacks from anon, authenticated;
