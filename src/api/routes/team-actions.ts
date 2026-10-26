import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { inboxUazapi } from "../../integrations/index.js";
import { getInbox } from "../../makecrm/client.js";
import { runAction } from "../../runtime/actions.js";
import { answerFromPanel, teamEventText, type TeamQuestionRow } from "../../runtime/team.js";
import { runTurn } from "../../runtime/turn.js";
import { Action } from "../../spec/actions.js";
import { parseSpec } from "../../spec/agent.js";
import { canCompany } from "../auth.js";
import { assertUuid, HttpError, notFound, parseBody } from "../http.js";
import { loadAgent, ModelDefaults, withModelDefaults } from "./agents.js";

/**
 * Ações (o "Testar" da aba, com a ação do rascunho) e Consulta à equipe (a
 * lista das dúvidas, responder pela tela — também no simulador, "como a
 * equipe" — e os grupos de WhatsApp da caixa para escolher).
 */

const ActionTest = z.object({
  action: z.unknown(),
  args: z.record(z.string(), z.unknown()).default({}),
  contact: z
    .object({ phone: z.string().max(40).nullable().default(null), name: z.string().max(120).nullable().default(null), facts: z.record(z.string(), z.unknown()).default({}) })
    .default({ phone: null, name: null, facts: {} }),
});

const Answer = z.object({
  answer: z.string().trim().min(1).max(4000),
  answered_by: z.string().trim().max(200).optional(),
  ...ModelDefaults,
});

export async function teamActionRoutes(app: FastifyInstance) {
  app.post("/v1/agents/:id/actions/test", async (req) => {
    await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(ActionTest, req.body);
    const parsed = Action.safeParse(body.action);
    if (!parsed.success)
      throw new HttpError(400, "Confira a ação.", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    return runAction(parsed.data, body.args, { phone: body.contact.phone, contactName: body.contact.name, facts: body.contact.facts });
  });

  app.get("/v1/agents/:id/team-questions", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { status?: string; simulation?: string; conversation?: string; limit?: string };
    const status = ["open", "answered", "expired", "canceled"].includes(q.status ?? "") ? q.status! : null;
    const simulation = q.simulation === "true";
    const conversation = q.conversation && /^[0-9a-f-]{36}$/i.test(q.conversation) ? q.conversation : null;
    const limit = Math.min(Number(q.limit) || 100, 500);
    const questions = await db()`
      select t.id, t.code, t.question, t.context, t.learn, t.status, t.channel, t.asked_at, t.due_at, t.reminders, t.answer, t.answered_by,
             t.answered_at, t.answer_source, t.delivered_at, t.knowledge_item_id, t.outcome, t.simulation,
             c.id as conversation_id, c.external_id as makecrm_conversation_id, c.contact_name, c.phone
      from public.team_questions t join public.conversations c on c.id = t.conversation_id
      where t.agent_id = ${a.id} and t.simulation = ${simulation}
        and (${status}::text is null or t.status = ${status}) and (${conversation}::uuid is null or t.conversation_id = ${conversation})
      order by t.asked_at desc limit ${limit}`;
    return { questions };
  });

  /** Responder pela tela. No simulador, o agente responde na hora (com o rascunho) e a vez volta aqui. */
  app.post("/v1/agents/:id/team-questions/:qid/answer", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const qid = (req.params as { qid: string }).qid;
    assertUuid(qid, "Dúvida");
    const body = parseBody(Answer, req.body);
    const [q] = await db()<TeamQuestionRow[]>`select * from public.team_questions where id = ${qid} and agent_id = ${a.id}`;
    if (!q) throw notFound("Dúvida");
    const ok = await answerFromPanel(q, body.answer, body.answered_by ?? req.client!.name);
    if (!ok) throw new HttpError(409, "Esta dúvida já foi respondida (ou passou do prazo).");
    if (!q.simulation) return { ok: true };
    const r = parseSpec(a.draft);
    if (!r.ok) throw new HttpError(422, "O rascunho tem campos inválidos.", r.errors);
    const spec = withModelDefaults(r.spec, body);
    const result = await runTurn({
      conversationId: q.conversation_id,
      spec,
      event: { text: teamEventText({ ...q, answer: body.answer }, "answer"), note: `Consulta à equipe #${q.code}: respondida no teste "${body.answer}"`, query: q.question },
    });
    await db()`update public.team_questions set delivered_at = now(), delivered_turn_id = ${result.turnId}, outcome = 'teste: resposta entregue', updated_at = now() where id = ${q.id}`;
    const [turn] = result.turnId ? await db()`select * from public.turns where id = ${result.turnId}` : [];
    return { ok: true, result, turn: turn ?? null };
  });

  app.post("/v1/agents/:id/team-questions/:qid/cancel", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const qid = (req.params as { qid: string }).qid;
    assertUuid(qid, "Dúvida");
    const [q] = await db()<{ id: string }[]>`
      update public.team_questions set status = 'canceled', due_at = null, outcome = 'cancelada pela tela', updated_at = now()
      where id = ${qid} and agent_id = ${a.id} and status = 'open' returning id`;
    if (!q) throw new HttpError(409, "Esta dúvida não está em aberto.");
    return { ok: true };
  });

  /** Os grupos de WhatsApp da caixa (QR Code), para escolher onde a equipe responde. */
  app.get("/v1/makecrm/companies/:companyId/inboxes/:inboxId/groups", async (req) => {
    const { companyId, inboxId } = req.params as { companyId: string; inboxId: string };
    if (!canCompany(req, companyId)) throw new HttpError(403, "Sem acesso a esta empresa.");
    assertUuid(inboxId, "Caixa");
    const inbox = await getInbox(inboxId);
    if (!inbox || inbox.company_id !== companyId) throw notFound("Caixa");
    const uaz = await inboxUazapi(inboxId);
    if (!uaz) throw new HttpError(400, "Esta caixa não é de WhatsApp por QR Code: grupos só pela caixa de QR Code.");
    const res = await fetch(`${uaz.base_url}/group/list?noparticipants=true`, { headers: { token: uaz.token, accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res?.ok) throw new HttpError(502, "Não foi possível ler os grupos do WhatsApp desta caixa (ela está conectada?).");
    const body = (await res.json().catch(() => null)) as unknown;
    const list = Array.isArray(body) ? body : ((body as { groups?: unknown[] })?.groups ?? []);
    const groups = (list as Record<string, unknown>[])
      .map((g) => ({ id: String(g.JID ?? g.jid ?? g.id ?? ""), name: String(g.Name ?? g.name ?? g.subject ?? g.Subject ?? "") }))
      .filter((g) => /@g\.us$/.test(g.id))
      .sort((x, y) => x.name.localeCompare(y.name, "pt-BR"));
    return { groups };
  });
}
