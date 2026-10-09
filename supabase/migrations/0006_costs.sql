-- Custos (Fase 4): cada gasto separado, ligado ao agente, à conversa, à
-- mensagem e à caixa. O total da vez continua em turns.cost_usd; os relatórios
-- leem daqui.

create table public.cost_events (
  id bigint generated always as identity primary key,
  agent_id uuid not null references public.agents (id) on delete cascade,
  company_id text not null,
  conversation_id uuid references public.conversations (id) on delete set null,
  -- Caixa do MakeCRM da conversa (null nas simulações e no que não é de conversa).
  inbox_id text,
  -- Mensagem a que o gasto se refere (a mídia recebida, o modelo aprovado enviado…).
  message_id bigint,
  turn_id uuid,
  simulation boolean not null default false,
  source text not null check (source in (
    'reply',          -- o agente pensando e respondendo (LLM)
    'followup',       -- retomada escrita pela IA
    'media_audio', 'media_image', 'media_video', 'media_document',
    'retrieval',      -- busca no conhecimento (vetor + reordenação)
    'summary',        -- resumo das mensagens antigas
    'knowledge',      -- processar o conhecimento (vetores, contexto dos trechos)
    'gaps',           -- lacunas (agrupar, título, sugestão de resposta)
    'insight',        -- leitura da conversa
    'reading',        -- Leitura da MAVI do período
    'waba_template',  -- modelo aprovado do WhatsApp Business API (tabela de preços)
    'test_persona', 'test_lead', 'test_judge'  -- testes com leads simulados
  )),
  provider text,
  model text,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  tokens_cached integer not null default 0,
  -- Áudio/vídeo: segundos (ou tokens de áudio); modelo aprovado: 1.
  units numeric(14, 3) not null default 0,
  cost_usd numeric(14, 6) not null default 0,
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now()
);
create index cost_events_agent on public.cost_events (agent_id, created_at);
create index cost_events_company on public.cost_events (company_id, created_at);
create index cost_events_conversation on public.cost_events (conversation_id, created_at) where conversation_id is not null;
create index cost_events_turn on public.cost_events (turn_id) where turn_id is not null;

-- Somas por dia (relatórios rápidos por dia, agente, caixa, tipo e modelo; a
-- conversa e cada gasto vêm de cost_events).
create table public.cost_daily (
  day date not null,
  agent_id uuid not null references public.agents (id) on delete cascade,
  company_id text not null,
  inbox_id text not null default '',
  source text not null,
  model text not null default '',
  simulation boolean not null default false,
  events integer not null default 0,
  cost_usd numeric(16, 6) not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  tokens_cached bigint not null default 0,
  units numeric(16, 3) not null default 0,
  primary key (day, agent_id, inbox_id, source, model, simulation)
);
create index cost_daily_company on public.cost_daily (company_id, day);

create or replace function public.cost_events_to_daily() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.cost_daily as d (day, agent_id, company_id, inbox_id, source, model, simulation,
                                      events, cost_usd, tokens_in, tokens_out, tokens_cached, units)
  values ((new.created_at at time zone 'America/Sao_Paulo')::date, new.agent_id, new.company_id, coalesce(new.inbox_id, ''),
          new.source, coalesce(new.model, ''), new.simulation, 1, new.cost_usd, new.tokens_in, new.tokens_out, new.tokens_cached, new.units)
  on conflict (day, agent_id, inbox_id, source, model, simulation) do update set
    events = d.events + 1, cost_usd = d.cost_usd + excluded.cost_usd, tokens_in = d.tokens_in + excluded.tokens_in,
    tokens_out = d.tokens_out + excluded.tokens_out, tokens_cached = d.tokens_cached + excluded.tokens_cached,
    units = d.units + excluded.units;
  return new;
end $$;
create trigger cost_events_daily after insert on public.cost_events for each row execute function public.cost_events_to_daily();

-- Preço do WhatsApp Business API por modelo aprovado enviado (Meta cobra por
-- mensagem de modelo, pela categoria e pelo país de quem recebe). '*' = outros
-- países. Editado no Painel da MAVI.
create table public.waba_prices (
  country text not null check (country = '*' or country ~ '^[A-Z]{2}$'),
  category text not null check (category in ('marketing', 'utility', 'authentication')),
  price_usd numeric(10, 6) not null check (price_usd >= 0),
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (country, category)
);
-- Ponto de partida (tabela da Meta para o Brasil, em US$): confira e ajuste no Painel.
insert into public.waba_prices (country, category, price_usd, updated_by) values
  ('BR', 'marketing', 0.0625, 'padrão'),
  ('BR', 'utility', 0.0068, 'padrão'),
  ('BR', 'authentication', 0.0068, 'padrão'),
  ('*', 'marketing', 0.0625, 'padrão'),
  ('*', 'utility', 0.0068, 'padrão'),
  ('*', 'authentication', 0.0068, 'padrão');

-- O que já foi gasto antes do registro separado (uma linha por vez, por leitura e por Leitura da MAVI).
-- Roda também no início do worker para as vezes feitas pela imagem antiga.
create or replace function public.cost_backfill() returns integer
language plpgsql set search_path = '' as $$
declare n integer := 0; k integer;
begin
  insert into public.cost_events (agent_id, company_id, conversation_id, inbox_id, turn_id, simulation, source, model,
                                  tokens_in, tokens_out, tokens_cached, cost_usd, meta, created_at)
  select t.agent_id, c.company_id, t.conversation_id, b.inbox_id, t.id, t.simulation,
         case when t.output ? 'followup' then 'followup' else 'reply' end, t.model,
         t.tokens_in, t.tokens_out, t.tokens_cached, t.cost_usd, '{"legacy": true}', t.created_at
  from public.turns t
  join public.conversations c on c.id = t.conversation_id
  left join public.bindings b on b.id = c.binding_id
  where t.cost_usd > 0 and not exists (select 1 from public.cost_events e where e.turn_id = t.id);
  get diagnostics k = row_count; n := n + k;

  insert into public.cost_events (agent_id, company_id, conversation_id, inbox_id, source, model, cost_usd, meta, created_at)
  select i.agent_id, c.company_id, i.conversation_id, b.inbox_id, 'insight', i.model, i.cost_usd, '{"legacy": true}', i.analyzed_at
  from public.conversation_insights i
  join public.conversations c on c.id = i.conversation_id
  left join public.bindings b on b.id = c.binding_id
  where i.cost_usd > 0 and not exists (
    select 1 from public.cost_events e where e.conversation_id = i.conversation_id and e.source = 'insight');
  get diagnostics k = row_count; n := n + k;

  insert into public.cost_events (agent_id, company_id, source, model, cost_usd, meta, created_at)
  select r.agent_id, a.company_id, 'reading', r.model, r.cost_usd,
         jsonb_build_object('legacy', true, 'from', r.period_from, 'to', r.period_to), r.created_at
  from public.agent_readings r join public.agents a on a.id = r.agent_id
  where r.cost_usd > 0 and not exists (
    select 1 from public.cost_events e where e.agent_id = r.agent_id and e.source = 'reading'
      and e.meta->>'from' = r.period_from::text and e.meta->>'to' = r.period_to::text);
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
select public.cost_backfill();

do $$
declare t text;
begin
  foreach t in array array['cost_events', 'cost_daily', 'waba_prices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.cost_backfill() from public, anon, authenticated;
