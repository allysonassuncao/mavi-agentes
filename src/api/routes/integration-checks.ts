import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { checkCalendar } from "../../integrations/calendar.js";
import { parseBody } from "../http.js";
import { loadAgent } from "./agents.js";

/**
 * Saúde das integrações para o construtor: testar a agenda de cada anfitrião
 * agora e ver as falhas recentes nas conversas reais (com o motivo e como
 * corrigir).
 */
export async function integrationCheckRoutes(app: FastifyInstance) {
  /** Testa o Google Agenda de cada usuário (os anfitriões do rascunho, mandados por quem pede). */
  app.post("/v1/agents/:id/integrations/google/test", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(z.object({ user_ids: z.array(z.string().min(1).max(64)).min(1).max(20) }), req.body);
    const results = await Promise.all([...new Set(body.user_ids)].map((u) => checkCalendar(a.company_id, u)));
    return { results };
  });

  /** Falhas das integrações nas conversas reais: por integração e motivo, e as últimas. */
  app.get("/v1/agents/:id/integration-failures", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 7, 1), 90);
    const groups = await db()`
      select integration, code, count(*)::int as n, max(created_at) as last_at,
             (array_agg(message order by created_at desc))[1] as last_message,
             count(*) filter (where notified)::int as notified
      from public.integration_failures
      where agent_id = ${a.id} and created_at > now() - make_interval(days => ${days})
      group by 1, 2 order by max(created_at) desc`;
    const recent = await db()`
      select f.id, f.integration, f.tool, f.code, f.message, f.notified, f.created_at, f.conversation_id, c.contact_name, c.phone
      from public.integration_failures f left join public.conversations c on c.id = f.conversation_id
      where f.agent_id = ${a.id} and f.created_at > now() - make_interval(days => ${days})
      order by f.created_at desc limit 20`;
    return { days, groups, recent };
  });
}
