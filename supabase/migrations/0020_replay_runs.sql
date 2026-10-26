-- Reencenar conversas reais (Importar do n8n no MAVI Tasks): uma bateria de
-- testes em que o lead não é simulado — as mensagens reais do lead entram na
-- ordem (o roteiro fica em personas[].script, com a resposta original do
-- agente de antes) e o avaliador compara a resposta original e a do agente
-- em cada vez (igual, melhor ou pior).
alter table public.test_runs drop constraint test_runs_kind_check;
alter table public.test_runs add constraint test_runs_kind_check check (kind in ('manual', 'publish', 'scheduled', 'replay'));
