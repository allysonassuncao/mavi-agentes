-- Treino automático (Agentes MAVI no MAVI Tasks): o agente roda baterias numa
-- cópia do rascunho até chegar na nota que a pessoa pediu.
--
-- Bateria do treino (kind 'training'): o spec vem de quem chama (a cópia),
-- as conversas também (as mesmas a cada rodada: leads simulados e conversas
-- reais reencenadas) e os modelos do lead simulado e do avaliador, com o preço.
--
-- Base em teste: itens novos (ou corrigidos) do treino ficam com training_id e
-- itens escondidos ficam em knowledge_hides. Só as conversas do mesmo treino
-- (conversations.training_id) os veem; as conversas reais, nunca. Aprovado no
-- fim, o item em teste vira item de verdade e o escondido sai da base.
alter table public.knowledge_items add column training_id text check (length(training_id) <= 64);
create index knowledge_items_training on public.knowledge_items (agent_id, training_id) where training_id is not null;

create table public.knowledge_hides (
  training_id text not null check (length(training_id) <= 64),
  item_id uuid not null references public.knowledge_items (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (training_id, item_id)
);
alter table public.knowledge_hides enable row level security;
revoke all on public.knowledge_hides from anon, authenticated;

alter table public.conversations add column training_id text check (length(training_id) <= 64);

alter table public.test_runs add column training_id text check (length(training_id) <= 64);
-- {lead: {ref, pricing}, judge: {ref, pricing}}: os modelos escolhidos no treino.
alter table public.test_runs add column models jsonb;
alter table public.test_runs drop constraint test_runs_kind_check;
alter table public.test_runs add constraint test_runs_kind_check check (kind in ('manual', 'publish', 'scheduled', 'replay', 'training'));
create index test_runs_training on public.test_runs (training_id) where training_id is not null;

-- A busca: os itens em teste só no treino deles; os escondidos pelo treino ficam de fora nele.
drop function public.kb_search(uuid, extensions.vector, text, integer, text[]);
create function public.kb_search(
  p_agent uuid,
  p_embedding extensions.vector(1536),
  p_query text,
  p_k integer default 6,
  p_kinds text[] default null,
  p_training text default null
) returns table (
  chunk_id uuid, item_id uuid, kind text, title text, content text, context text,
  meta jsonb, score double precision, vector_rank integer, keyword_rank integer
)
language plpgsql stable set search_path = '' as $$
declare
  v_pool integer := greatest(p_k * 5, 30);
begin
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
  where (i.training_id is null or i.training_id = p_training)
    and (p_training is null or not exists (select 1 from public.knowledge_hides h where h.training_id = p_training and h.item_id = i.id))
  order by f.s desc
  limit p_k;
end $$;
revoke execute on function public.kb_search(uuid, extensions.vector, text, integer, text[], text) from public, anon, authenticated;
