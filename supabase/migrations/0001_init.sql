-- MAVI Agentes — esquema inicial (Fase 1).
-- Só o motor acessa este banco (conexão do dono das tabelas). As tabelas ficam
-- fechadas para a API de dados do Supabase (anon/authenticated).

create extension if not exists vector with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- unaccent não é IMMUTABLE; o índice e o tsvector precisam de uma versão que seja.
create or replace function public.f_unaccent(text) returns text
language sql immutable parallel safe strict
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, $1) $$;

-- ------------------------------------------------------------ clientes da API
-- Quem chama a API de administração (MAVI Tasks, construtor do MakeCRM…).
-- company_scope null = todas as empresas do MakeCRM.
create table public.api_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  key_hash text not null unique,
  key_hint text not null default '',
  scopes text[] not null default '{admin}',
  company_scope text[],
  active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ agentes
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  -- Empresa no MakeCRM (companies.id de lá). Todo cliente tem MakeCRM.
  company_id text not null check (length(company_id) between 1 and 64),
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Onde foi criado: 'mavi_tasks' (equipe) ou 'makecrm' (o próprio cliente).
  origin text not null default 'mavi_tasks' check (origin in ('mavi_tasks', 'makecrm')),
  -- Referências de quem criou (ex.: {"mavi_client_id": "...", "mavi_contract_id": "..."}).
  external_ref jsonb not null default '{}' check (jsonb_typeof(external_ref) = 'object'),
  status text not null default 'active' check (status in ('active', 'paused')),
  draft jsonb not null check (jsonb_typeof(draft) = 'object'),
  draft_updated_at timestamptz not null default now(),
  draft_updated_by text,
  published_version integer,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agents_company on public.agents (company_id) where archived_at is null;

create table public.agent_versions (
  agent_id uuid not null references public.agents (id) on delete cascade,
  version integer not null check (version >= 1),
  spec jsonb not null check (jsonb_typeof(spec) = 'object'),
  note text not null default '' check (length(note) <= 500),
  restored_from integer,
  published_by text,
  created_at timestamptz not null default now(),
  primary key (agent_id, version)
);

-- ------------------------------------------------------------ ligações com caixas do MakeCRM
-- O Go do MakeCRM manda as mensagens para /v1/inbound/makecrm/<token>; o token
-- (só o hash fica aqui) diz qual ligação é. previous_webhook_url volta para a
-- caixa quando a ligação é desfeita.
create table public.bindings (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  company_id text not null,
  inbox_id text not null check (length(inbox_id) between 1 and 64),
  inbox_name text not null default '',
  token_hash text not null unique,
  previous_webhook_url text,
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  removed_at timestamptz
);
create unique index bindings_one_per_inbox on public.bindings (inbox_id) where removed_at is null;
create index bindings_agent on public.bindings (agent_id) where removed_at is null;

-- ------------------------------------------------------------ conversas e memória
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- null nas simulações.
  binding_id uuid references public.bindings (id) on delete set null,
  company_id text not null,
  -- Conversa no MakeCRM (inbox_conversations.id); nas simulações, a chave da simulação.
  external_id text not null check (length(external_id) between 1 and 128),
  simulation boolean not null default false,
  phone text,
  contact_name text,
  mavi_user_id text,
  -- Resumo das mensagens antigas (até summary_upto) e dados coletados do contato.
  summary text not null default '',
  summary_upto bigint,
  facts jsonb not null default '{}' check (jsonb_typeof(facts) = 'object'),
  last_inbound_at timestamptz,
  last_reply_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent_id, simulation, external_id)
);

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'note')),
  content text not null default '',
  content_type text not null default 'text',
  -- Mídia recebida/enviada: {url, mime, kind, description, error}.
  media jsonb,
  -- Id da mensagem no provedor (evita duplicar quando o Go reenvia).
  source_id text,
  turn_id uuid,
  created_at timestamptz not null default now()
);
create index messages_conversation on public.messages (conversation_id, id);
create unique index messages_source on public.messages (conversation_id, source_id) where source_id is not null;

-- ------------------------------------------------------------ rastros
create table public.turns (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  -- null = rascunho (simulação).
  agent_version integer,
  simulation boolean not null default false,
  status text not null check (status in ('done', 'silent', 'error', 'skipped')),
  input_message_ids bigint[] not null default '{}',
  model text,
  rounds integer not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  tokens_cached integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  -- {buffer, media, retrieval, llm, send, total} em ms.
  timings jsonb not null default '{}',
  tools jsonb not null default '[]',
  retrieved jsonb not null default '[]',
  output jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index turns_agent on public.turns (agent_id, created_at desc);
create index turns_conversation on public.turns (conversation_id, created_at desc);

-- Totais por dia (ficam para sempre; os rastros saem depois de 90 dias).
create table public.usage_daily (
  agent_id uuid not null references public.agents (id) on delete cascade,
  day date not null,
  simulation boolean not null default false,
  turns integer not null default 0,
  errors integer not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  tokens_cached bigint not null default 0,
  cost_usd numeric(14, 6) not null default 0,
  primary key (agent_id, day, simulation)
);

create or replace function public.turns_to_usage() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.usage_daily as u (agent_id, day, simulation, turns, errors, tokens_in, tokens_out, tokens_cached, cost_usd)
  values (new.agent_id, (new.created_at at time zone 'America/Sao_Paulo')::date, new.simulation, 1,
          (new.status = 'error')::int, new.tokens_in, new.tokens_out, new.tokens_cached, new.cost_usd)
  on conflict (agent_id, day, simulation) do update set
    turns = u.turns + 1,
    errors = u.errors + excluded.errors,
    tokens_in = u.tokens_in + excluded.tokens_in,
    tokens_out = u.tokens_out + excluded.tokens_out,
    tokens_cached = u.tokens_cached + excluded.tokens_cached,
    cost_usd = u.cost_usd + excluded.cost_usd;
  return new;
end $$;
create trigger turns_usage after insert on public.turns for each row execute function public.turns_to_usage();

-- ------------------------------------------------------------ conhecimento
create table public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents (id) on delete cascade,
  kind text not null check (kind in ('faq', 'product', 'document', 'media', 'example', 'text')),
  title text not null default '' check (length(title) <= 300),
  -- Texto (faq: resposta; text/example: o texto; document: extraído).
  body text not null default '',
  -- faq: {question, answer}; product: {name, price, sku, category, attributes};
  -- media: {url, mime, media_kind, description}.
  data jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
  -- {type: 'text'|'upload'|'url', filename, mime, size, storage_path, url}
  source jsonb not null default '{}' check (jsonb_typeof(source) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'error')),
  error text,
  content_hash text,
  chunk_count integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index knowledge_items_agent on public.knowledge_items (agent_id, kind) where deleted_at is null;

create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.knowledge_items (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  kind text not null,
  ord integer not null default 0,
  title text not null default '',
  content text not null,
  -- Frase que situa o trecho no documento (entra no vetor e na busca).
  context text not null default '',
  meta jsonb not null default '{}',
  embedding extensions.vector(1536),
  embedding_model text,
  tsv tsvector,
  tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index knowledge_chunks_item on public.knowledge_chunks (item_id);
create index knowledge_chunks_agent on public.knowledge_chunks (agent_id, kind);
create index knowledge_chunks_tsv on public.knowledge_chunks using gin (tsv);
create index knowledge_chunks_embedding on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);

create or replace function public.knowledge_chunks_tsv() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.tsv :=
    setweight(to_tsvector('portuguese', public.f_unaccent(coalesce(new.title, ''))), 'A') ||
    setweight(to_tsvector('portuguese', public.f_unaccent(coalesce(new.content, ''))), 'B') ||
    setweight(to_tsvector('portuguese', public.f_unaccent(coalesce(new.context, ''))), 'C');
  return new;
end $$;
create trigger knowledge_chunks_tsv before insert or update of title, content, context
  on public.knowledge_chunks for each row execute function public.knowledge_chunks_tsv();

-- Busca híbrida: vetor + palavra-chave, unidas por RRF (k = 60).
create or replace function public.kb_search(
  p_agent uuid,
  p_embedding extensions.vector(1536),
  p_query text,
  p_k integer default 6,
  p_kinds text[] default null
) returns table (
  chunk_id uuid, item_id uuid, kind text, title text, content text, context text,
  meta jsonb, score double precision, vector_rank integer, keyword_rank integer
)
language plpgsql stable set search_path = '' as $$
declare
  v_pool integer := greatest(p_k * 5, 30);
begin
  -- pgvector 0.8: continua varrendo o índice até achar o suficiente depois do filtro.
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
  perform set_config('hnsw.ef_search', '100', true);
  return query
  with vec as (
    select c.id, row_number() over (order by c.embedding operator(extensions.<=>) p_embedding) as r
    from public.knowledge_chunks c
    where c.agent_id = p_agent and p_embedding is not null and c.embedding is not null
      and (p_kinds is null or c.kind = any (p_kinds))
    order by c.embedding operator(extensions.<=>) p_embedding
    limit v_pool
  ),
  q as (
    select websearch_to_tsquery('portuguese', public.f_unaccent(coalesce(p_query, ''))) as tq
  ),
  kw as (
    select c.id, row_number() over (order by ts_rank_cd(c.tsv, q.tq) desc) as r
    from public.knowledge_chunks c, q
    where c.agent_id = p_agent and q.tq is not null and c.tsv @@ q.tq
      and (p_kinds is null or c.kind = any (p_kinds))
    order by ts_rank_cd(c.tsv, q.tq) desc
    limit v_pool
  ),
  fused as (
    select coalesce(vec.id, kw.id) as id,
           coalesce(1.0 / (60 + vec.r), 0) + coalesce(1.0 / (60 + kw.r), 0) as s,
           vec.r::integer as vr, kw.r::integer as kr
    from vec full outer join kw on kw.id = vec.id
  )
  select c.id, c.item_id, c.kind, c.title, c.content, c.context, c.meta, f.s::double precision, f.vr, f.kr
  from fused f
  join public.knowledge_chunks c on c.id = f.id
  join public.knowledge_items i on i.id = c.item_id and i.deleted_at is null and i.status = 'ready'
  order by f.s desc
  limit p_k;
end $$;

-- ------------------------------------------------------------ fechado para a API de dados
do $$
declare t text;
begin
  foreach t in array array['api_clients', 'agents', 'agent_versions', 'bindings', 'conversations', 'messages',
                           'turns', 'usage_daily', 'knowledge_items', 'knowledge_chunks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.kb_search(uuid, extensions.vector, text, integer, text[]) from public, anon, authenticated;

-- ------------------------------------------------------------ limpeza (rastros 90 dias)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('mavi-agentes-retention', '17 4 * * *', $job$
      delete from public.turns where created_at < now() - interval '90 days';
    $job$);
  end if;
end $$;
