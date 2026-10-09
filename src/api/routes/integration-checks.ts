import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { checkCalendar } from "../../integrations/calendar.js";
import { ACTIONABLE_CODES, type ActionDebug } from "../../integrations/debug.js";
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

  /** Cenários acionados nas conversas reais: quantos por cenário e os últimos. */
  app.get("/v1/agents/:id/scenario-runs", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 30, 1), 180);
    const groups = await db()`
      select scenario_id, max(scenario_name) as scenario_name, count(*)::int as n, max(created_at) as last_at
      from public.scenario_runs
      where agent_id = ${a.id} and not simulation and created_at > now() - make_interval(days => ${days})
      group by 1 order by count(*) desc`;
    const recent = await db()`
      select r.id, r.scenario_id, r.scenario_name, r.reason, r.actions, r.created_at, r.conversation_id, c.contact_name, c.phone
      from public.scenario_runs r left join public.conversations c on c.id = r.conversation_id
      where r.agent_id = ${a.id} and not r.simulation and r.created_at > now() - make_interval(days => ${days})
      order by r.created_at desc limit 30`;
    return { days, groups, recent };
  });

  /**
   * Registro técnico: cada ação que o agente executou nas conversas reais
   * (agenda, CRM, aviso, cenários, transferência) e as respostas que falharam,
   * com o diagnóstico (o que deu, por quê e o que ajustar). Página por
   * "before" (data da resposta); vem a resposta inteira, sem cortar no meio.
   * "patterns": os motivos que se repetiram nos últimos 7 dias (o alerta).
   */
  app.get("/v1/agents/:id/action-log", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { days?: string; before?: string; tools?: string; outcome?: string; conversation?: string; limit?: string };
    const days = Math.min(Math.max(Number(q.days) || 7, 1), 90);
    const limit = Math.min(Math.max(Number(q.limit) || 50, 10), 100);
    const before = q.before && !Number.isNaN(Date.parse(q.before)) ? new Date(q.before) : null;
    const tools = q.tools ? q.tools.split(",").map((t) => t.trim()).filter((t) => /^[a-z_]{2,40}$/.test(t)).slice(0, 20) : null;
    const outcome = q.outcome && /^(ok|empty|blocked|error|simulated)$/.test(q.outcome) ? q.outcome : null;
    const conversation = q.conversation && /^[0-9a-f-]{36}$/i.test(q.conversation) ? q.conversation : null;
    const sql = db();
    const rows = await sql<
      { turn_id: string; created_at: Date; conversation_id: string; contact_name: string | null; phone: string | null; ord: number; tool: string; args: unknown; result: string | null; debug: Record<string, unknown> | null; ms: number | null }[]
    >`
      with entries as (
        select t.id as turn_id, t.created_at, t.conversation_id, x.ord::int as ord, x.e->>'name' as tool, x.e->'args' as args,
               x.e->>'result' as result, x.e->'debug' as debug, (x.e->>'ms')::int as ms
        from public.turns t cross join lateral jsonb_array_elements(t.tools) with ordinality as x(e, ord)
        where t.agent_id = ${a.id} and not t.simulation and t.created_at > now() - make_interval(days => ${days})
          and (${before}::timestamptz is null or t.created_at < ${before}::timestamptz)
          and (${conversation}::uuid is null or t.conversation_id = ${conversation}::uuid)
          and x.e->>'name' not in ('responder', 'buscar_conhecimento', 'registrar_dados_do_contato')
        union all
        select t.id, t.created_at, t.conversation_id, 0, 'resposta', null, t.error,
               jsonb_build_object('outcome', 'error', 'code', 'turn_error', 'summary', coalesce(t.error, 'A resposta falhou.'),
                 'hint', 'O agente não respondeu esta mensagem. Se for falta de saldo ou chave do provedor, ajuste em Comportamento › Chaves; senão, tente de novo.'),
               null
        from public.turns t
        where t.agent_id = ${a.id} and not t.simulation and t.status = 'error' and t.created_at > now() - make_interval(days => ${days})
          and (${before}::timestamptz is null or t.created_at < ${before}::timestamptz)
          and (${conversation}::uuid is null or t.conversation_id = ${conversation}::uuid)
      )
      select e.*, c.contact_name, c.phone from entries e join public.conversations c on c.id = e.conversation_id
      where (${tools}::text[] is null or e.tool = any (${tools}::text[]))
        and (${outcome}::text is null or coalesce(e.debug->>'outcome',
              case when e.result like 'Não deu certo%' then 'error' when e.result like 'Já %' then 'blocked'
                   when e.result like 'Não há horários%' or e.result like 'Só consigo marcar%' or e.result like 'O lead não tem oportunidade%' then 'empty' else 'ok' end) = ${outcome})
      order by e.created_at desc, e.ord desc
      limit ${limit * 3}`;
    // Corta na fronteira de uma resposta (as ações da mesma resposta ficam juntas).
    let page = [...rows];
    let next: string | null = null;
    if (rows.length > limit) {
      const cut = rows[limit - 1]!.created_at.getTime();
      page = rows.filter((r) => r.created_at.getTime() >= cut);
      if (page.length < rows.length) next = rows[page.length - 1]!.created_at.toISOString();
      else if (rows.length === limit * 3) next = rows[rows.length - 1]!.created_at.toISOString();
    }
    const entries = page.map((r) => ({
      ...r,
      result: r.result ? r.result.slice(0, 1500) : null,
      // Rastros antigos (antes do diagnóstico): o resultado vira o resumo.
      debug: r.debug ?? legacyDebug(r.result ?? ""),
    }));

    const patterns = before || conversation
      ? []
      : await sql`
          select x.e->'debug'->>'code' as code, x.e->>'name' as tool, count(*)::int as n,
                 count(distinct t.conversation_id)::int as leads, max(t.created_at) as last_at,
                 (array_agg(x.e->'debug'->>'summary' order by t.created_at desc))[1] as summary,
                 (array_agg(x.e->'debug'->>'hint' order by t.created_at desc))[1] as hint
          from public.turns t cross join lateral jsonb_array_elements(t.tools) as x(e)
          where t.agent_id = ${a.id} and not t.simulation and t.created_at > now() - interval '7 days'
            and x.e->'debug'->>'outcome' in ('empty', 'error') and x.e->'debug'->>'code' = any (${[...ACTIONABLE_CODES]}::text[])
          group by 1, 2
          having count(distinct t.conversation_id) >= 2 or count(*) >= 3
          order by count(distinct t.conversation_id) desc, count(*) desc limit 10`;
    return { days, entries, next, patterns };
  });
}

function legacyDebug(result: string): ActionDebug {
  const first = result.split("\n")[0]!.slice(0, 300);
  if (result.startsWith("Não deu certo")) return { outcome: "error", summary: first };
  if (result.startsWith("Já ")) return { outcome: "blocked", summary: first };
  if (/^(Não há horários|Só consigo marcar|O lead não tem oportunidade)/.test(result)) return { outcome: "empty", summary: first };
  return { outcome: "ok", summary: first };
}
