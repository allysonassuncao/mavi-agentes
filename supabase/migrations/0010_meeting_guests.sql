-- Convidados extras das reuniões marcadas pelo agente (o lead pediu para
-- incluir o sócio, a equipe…). attendee_email continua sendo o lead; o agente
-- só remove quem está aqui (quem entrou por esta conversa).
alter table public.agent_meetings add column guests text[] not null default '{}';
