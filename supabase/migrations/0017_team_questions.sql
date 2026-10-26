-- Consulta à equipe: a dúvida que o agente não sabe responder vai para a
-- equipe pelo WhatsApp (telefones ou grupo) e o agente segura o lead até a
-- resposta. A resposta chega citando a mensagem (reply_id = sent_ids), com o
-- código ou pela tela do construtor; o agente responde ao lead e, se puder, a
-- resposta vira pergunta frequente na base. Sem resposta a tempo, a ação
-- configurada (lembrar, transferir ou desistir) roda em due_at.
create table public.team_questions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  simulation boolean not null default false,
  -- Vai na mensagem para a equipe responder com ele (ex.: K7P2).
  code text not null check (code ~ '^[A-Z0-9]{4,6}$'),
  question text not null check (length(question) between 1 and 1000),
  context text not null default '' check (length(context) <= 1000),
  -- O agente achou que a resposta pode virar pergunta frequente (não muda com o tempo).
  learn boolean not null default false,
  status text not null default 'open' check (status in ('open', 'answered', 'expired', 'canceled')),
  -- {mode, inbox_id, phones, group_id}: para onde foi (a configuração pode mudar depois).
  channel jsonb not null default '{}' check (jsonb_typeof(channel) = 'object'),
  -- Ids das mensagens do WhatsApp enviadas (a dúvida e os lembretes), para casar a citação.
  sent_ids text[] not null default '{}',
  asked_at timestamptz not null default now(),
  -- Quando roda a ação de "sem resposta" (null = não roda mais).
  due_at timestamptz,
  reminders int not null default 0,
  answer text check (length(answer) <= 4000),
  answered_by text,
  answered_at timestamptz,
  -- whatsapp: a equipe respondeu no WhatsApp; panel: alguém respondeu pela tela.
  answer_source text check (answer_source in ('whatsapp', 'panel')),
  -- A mensagem do MakeCRM que trouxe a resposta (não processa duas vezes).
  answer_message_id text,
  -- O agente já respondeu ao lead com a resposta (ou a ação de sem resposta rodou).
  delivered_at timestamptz,
  delivered_turn_id uuid,
  knowledge_item_id uuid,
  outcome text,
  turn_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index team_questions_open_code on public.team_questions (agent_id, code) where status = 'open';
create index team_questions_open on public.team_questions (agent_id, asked_at) where status = 'open';
create index team_questions_due on public.team_questions (due_at) where status = 'open' and not simulation and due_at is not null;
create index team_questions_undelivered on public.team_questions (answered_at) where status = 'answered' and delivered_at is null;
create index team_questions_conversation on public.team_questions (conversation_id, created_at desc);
create unique index team_questions_answer_message on public.team_questions (answer_message_id) where answer_message_id is not null;
alter table public.team_questions enable row level security;
revoke all on public.team_questions from anon, authenticated;
