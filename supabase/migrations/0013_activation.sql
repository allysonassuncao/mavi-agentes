-- Ativação por gatilho (spec.activation): quando a conversa passou a ser
-- respondida pelo agente. Agentes sem gatilho marcam na primeira mensagem;
-- zerar a memória volta para null (o gatilho rearma).
alter table public.conversations add column activated_at timestamptz;

-- As conversas que já existem foram todas atendidas sem gatilho.
update public.conversations set activated_at = created_at where activated_at is null;
