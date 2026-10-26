-- Follow-up por funil e etapa: a régua que está valendo para o lead (a padrão
-- ou a de uma etapa do MakeCRM). O motor confere a etapa a cada envio; se o
-- lead mudou para uma etapa com outra régua, recomeça por ela.
alter table public.conversations add column followup_track text;
