-- Testes salvos: a conversa do simulador (aba Testar) guarda quem testou e de
-- onde veio, e "Nova conversa" encerra o teste em vez de apagar (ended_at; a
-- conversa ganha outro external_id e a próxima começa do zero). A aba
-- Conversas lista os testes da aba Testar para auditoria, só leitura.
alter table public.conversations add column tester text check (length(tester) <= 200);
alter table public.conversations add column test_origin text check (test_origin in ('testar', 'mavi', 'other'));
alter table public.conversations add column ended_at timestamptz;
create index conversations_tests on public.conversations (agent_id, created_at desc) where simulation and test_origin = 'testar';
