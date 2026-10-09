-- Lacunas do treinamento e insights das conversas (Fase 3).

-- Quanto das conversas a MAVI lê para os insights (0 a 100%). Fica fora da
-- especificação: muda na hora, sem publicar versão.
alter table public.agents
  add column insights_sample_percent integer not null default 20 check (insights_sample_percent between 0 and 100);

-- ------------------------------------------------------------ lacunas
-- Temas: perguntas/objeções parecidas agrupadas pelo vetor.
create table public.gap_topics (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  kind text not null check (kind in ('question', 'objection')),
  title text not null check (length(btrim(title)) between 1 and 300),
  -- O título foi escrito pela MAVI (depois de algumas ocorrências) ou por uma pessoa.
  title_source text not null default 'first' check (title_source in ('first', 'mavi', 'person')),
  category text not null default '' check (length(category) <= 60),
  status text not null default 'open' check (status in ('open', 'trained', 'ignored')),
  occurrences integer not null default 0,
  conversations integer not null default 0,
  -- Ocorrências depois de entrar no treinamento (o treinamento não resolveu?).
  after_trained integer not null default 0,
  centroid extensions.vector(1536),
  -- Resposta sugerida pela MAVI: {question, answer, note, sources, model, generated_at}.
  suggestion jsonb,
  knowledge_item_id uuid,
  trained_at timestamptz,
  trained_by text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index gap_topics_agent on public.gap_topics (agent_id, status, last_seen_at desc);

-- Cada ocorrência: o agente avisou (na mesma chamada da resposta) que o
-- treinamento não cobria o que o lead perguntou/objetou.
create table public.gaps (
  id bigint generated always as identity primary key,
  agent_id uuid not null references public.agents (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  turn_id uuid,
  kind text not null check (kind in ('question', 'objection')),
  text text not null check (length(btrim(text)) between 1 and 500),
  category text not null default '' check (length(category) <= 60),
  -- O que o lead escreveu (trecho), para ver no exemplo.
  lead_text text not null default '' check (length(lead_text) <= 1000),
  embedding extensions.vector(1536),
  topic_id uuid references public.gap_topics (id) on delete set null,
  created_at timestamptz not null default now()
);
create index gaps_agent on public.gaps (agent_id, created_at desc);
create index gaps_topic on public.gaps (topic_id, created_at desc);
create index gaps_pending on public.gaps (id) where topic_id is null;

-- ------------------------------------------------------------ insights
-- A leitura de cada conversa (na amostra) quando ela esfria.
create table public.conversation_insights (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- Até qual mensagem foi lido (mensagem nova depois = ler de novo).
  last_message_id bigint not null,
  -- Última atividade da conversa quando foi lida (é por ela que entra no período).
  activity_at timestamptz not null,
  intent text not null default '',
  outcome text not null check (outcome in ('scheduled', 'purchased', 'qualified', 'handed_off', 'in_progress', 'not_interested', 'ghosted', 'disqualified', 'other')),
  outcome_reason text not null default '',
  -- O motivo em poucas palavras, para agrupar ("preço alto", "sem tempo agora").
  reason_label text not null default '',
  sentiment text not null default 'neutral' check (sentiment in ('positive', 'neutral', 'negative')),
  objections text[] not null default '{}',
  topics text[] not null default '{}',
  -- [{type, detail}]: resposta errada, repetição, ignorou pergunta, prometeu demais…
  agent_issues jsonb not null default '[]',
  summary text not null default '',
  lead_messages integer not null default 0,
  model text,
  cost_usd numeric(12, 6) not null default 0,
  analyzed_at timestamptz not null default now()
);
create index conversation_insights_agent on public.conversation_insights (agent_id, activity_at desc);

-- Relatórios por período e a varredura das conversas que esfriaram.
create index if not exists messages_created_brin on public.messages using brin (created_at);
create index if not exists conversations_activity on public.conversations (greatest(last_inbound_at, last_reply_at)) where not simulation;

-- A Leitura da MAVI de um período (guardada para não pagar de novo).
create table public.agent_readings (
  agent_id uuid not null references public.agents (id) on delete cascade,
  period_from date not null,
  period_to date not null,
  reading jsonb not null,
  model text,
  cost_usd numeric(12, 6) not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  primary key (agent_id, period_from, period_to)
);

do $$
declare t text;
begin
  foreach t in array array['gap_topics', 'gaps', 'conversation_insights', 'agent_readings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
