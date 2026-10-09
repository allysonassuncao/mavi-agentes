-- Zerar a memória do agente numa conversa: quem zerou e quando (as mensagens,
-- o resumo e os dados do contato saem; rastros e custos ficam).
alter table public.conversations
  add column memory_reset_at timestamptz,
  add column memory_reset_by text;
