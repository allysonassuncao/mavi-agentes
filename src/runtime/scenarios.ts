import { db } from "../db.js";
import { cancelDealMeetings, activityAssignee, addNote, conversationDeals, createActivity, markLost } from "../integrations/deal-actions.js";
import { addPrivateNote, userNames } from "../integrations/deals.js";
import { moveDealsTo, sendTeamNotice, type IntegrationCtx } from "../integrations/index.js";
import { SCENARIO_TOOL } from "../integrations/prompt.js";
import { spLabel } from "../integrations/time.js";
import type { ToolDef } from "../llm/client.js";
import { log } from "../log.js";
import { rest } from "../makecrm/client.js";
import { redis } from "../redis.js";
import type { AgentSpec } from "../spec/agent.js";
import type { ScenarioT } from "../spec/scenarios.js";

/**
 * Cenários fora do roteiro ("quando o lead pedir X, faça Y"). O agente aciona
 * pela ferramenta acionar_cenario; o motor faz as ações no MakeCRM na hora e,
 * depois de enviar a resposta, desliga a IA na conversa se o cenário pedir.
 * Tudo fica registrado no histórico da oportunidade, numa nota privada da
 * conversa e em scenario_runs (aba Cenários do construtor).
 */

export { SCENARIO_TOOL };

const active = (spec: AgentSpec) => spec.scenarios.filter((s) => s.enabled);

export function scenarioTool(spec: AgentSpec): ToolDef | null {
  const list = active(spec);
  if (!list.length) return null;
  return {
    type: "function",
    function: {
      name: SCENARIO_TOOL,
      description: `Aciona um cenário combinado quando a mensagem do lead se encaixar nele (antes de responder). Cenários:\n${list.map((s) => `- ${s.id}: ${s.when}`).join("\n")}`,
      parameters: {
        type: "object",
        properties: {
          cenario: { type: "string", enum: list.map((s) => s.id) },
          motivo: { type: "string", description: "O que o lead disse, em poucas palavras (fica registrado no CRM)." },
        },
        required: ["cenario", "motivo"],
      },
    },
  };
}

export type ScenarioHit = {
  scenario: ScenarioT;
  reason: string;
  /** O que foi feito (para o rastro e a nota). */
  done: string[];
};

/** Executa as ações do cenário (menos desligar a IA, que vem depois do envio). */
export async function runScenario(spec: AgentSpec, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<{ result: string; hit?: ScenarioHit }> {
  const s = active(spec).find((x) => x.id === String(args.cenario ?? ""));
  if (!s) return { result: "Cenário desconhecido." };
  const reason = String(args.motivo ?? "").trim().slice(0, 500);
  const a = s.actions;
  const done: string[] = [];
  const guide =
    s.reply === "fixed"
      ? "A resposta ao lead já está definida: chame responder com uma mensagem curta qualquer (ela será trocada)."
      : s.reply === "none"
        ? "Não responda nada: chame responder com `mensagens` vazio."
        : a.turn_off_ai
          ? "Responda ao lead com uma mensagem curta e respeitosa; esta é a sua última mensagem nesta conversa."
          : "Responda ao lead normalmente, de acordo com o cenário.";

  if (ctx.simulation) {
    const plan = await describe(s);
    return { result: `Simulação: o cenário "${s.name}" faria: ${plan.join("; ") || "nada no CRM"}. ${guide}`, hit: { scenario: s, reason, done: plan } };
  }
  if (!(await redis().set(`sc:${ctx.conversationId}:${s.id}`, "1", "EX", 6 * 3600, "NX"))) return { result: `Cenário já acionado nesta conversa. ${guide}`, hit: { scenario: s, reason, done: ["já acionado antes"] } };

  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      done.push(label);
    } catch (e) {
      log.warn({ agent: ctx.agentId, scenario: s.id, step: label, err: e instanceof Error ? e.message : String(e) }, "cenário: ação falhou");
      done.push(`${label} (falhou: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)})`);
    }
  };

  const deals = ctx.makecrmConversationId ? await conversationDeals(ctx.makecrmConversationId, { closed: true }) : [];
  const open = deals.filter((d) => d.status === 1);
  const main = open[0] ?? null;

  if (a.cancel_meetings && !a.lost_reason_id) await step("reuniões futuras canceladas", () => cancelDealMeetings(ctx, open.map((d) => d.id), s.name));
  if (a.stage && open.length) await step("oportunidade movida de etapa", () => moveDealsTo(ctx, a.stage!.pipeline_id, a.stage!.stage_id, `cenário ${s.name}`, true));
  if (a.activity && main) {
    const act = a.activity;
    await step(`atividade "${act.subject}" criada`, async () => {
      const userId = await activityAssignee(ctx, main, act.assignee, `scenario:${s.id}`);
      await createActivity(ctx, main, { typeId: act.type_id, subject: act.subject, description: reason ? `O lead: ${reason}` : "", doIn: new Date(Date.now() + act.due_hours * 3600_000), userId });
    });
  }
  // O registro vem antes de dar como perdida (a tela do MakeCRM fecha o histórico das perdidas).
  const record = deals.length ? (open.length ? open : deals.slice(0, 1)).map((d) => d.id) : [];
  if (record.length) await step("motivo registrado no histórico", () => addNote(ctx, record, `Cenário: ${s.name}`, reason ? `O lead: ${reason}` : s.when));
  if (a.lost_reason_id)
    for (const d of open)
      await step("oportunidade dada como perdida", () => markLost(ctx, d, a.lost_reason_id!, reason || s.name, { cancelMeetings: a.cancel_meetings, completeActivities: a.complete_activities }));
  if (a.notify_team) {
    const nt = ctx.spec.integrations.find((i) => i.enabled && i.type === "team_notify");
    if (nt && nt.type === "team_notify") await step("equipe avisada", () => sendTeamNotice(nt, `Cenário "${s.name}"${reason ? `: ${reason}` : ""}`, ctx));
  }
  if (a.stop_followup || a.turn_off_ai) {
    await db()`update public.conversations set followup_next_at = null, followup_state = 'idle' where id = ${ctx.conversationId}`;
    done.push("follow-up parado");
  }
  if (!deals.length && (a.lost_reason_id || a.activity || a.stage)) done.push("sem oportunidade no CRM para as ações na oportunidade");
  return { result: `Cenário "${s.name}" acionado. ${guide}`, hit: { scenario: s, reason, done } };
}

/** Depois do envio: desliga a IA na conversa (se pedido), deixa a nota privada e o registro. */
export async function finishScenario(hit: ScenarioHit, ctx: IntegrationCtx, turnId: string | null): Promise<void> {
  const s = hit.scenario;
  if (!ctx.simulation && ctx.makecrmConversationId) {
    if (s.actions.turn_off_ai) {
      await rest(`inbox_conversations?id=eq.${encodeURIComponent(ctx.makecrmConversationId)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ ia_actived: false }),
      })
        .then(() => hit.done.push("MAVI desligada nesta conversa"))
        .catch((e) => hit.done.push(`desligar a MAVI falhou: ${String(e).slice(0, 160)}`));
    }
    if (ctx.inboxId)
      await addPrivateNote(
        ctx.makecrmConversationId,
        ctx.inboxId,
        `Cenário "${s.name}" acionado pela MAVI${hit.reason ? ` (o lead: ${hit.reason})` : ""}.\nFeito: ${hit.done.join("; ") || "—"}.`,
      ).catch(() => {});
  }
  await db()`
    insert into public.scenario_runs (agent_id, conversation_id, turn_id, scenario_id, scenario_name, reason, actions, simulation)
    values (${ctx.agentId}, ${ctx.conversationId}, ${turnId}, ${s.id}, ${s.name}, ${hit.reason}, ${db().json(hit.done as never)}, ${ctx.simulation})`.catch((e) =>
    log.warn({ err: String(e) }, "cenário: registro não gravado"),
  );
}

/** O que o cenário faria (simulação e tela). */
async function describe(s: ScenarioT): Promise<string[]> {
  const a = s.actions;
  const out: string[] = [];
  if (a.lost_reason_id) {
    const [r] = await rest<{ name: string }[]>(`lost_reasons?select=name&id=eq.${a.lost_reason_id}`).catch(() => []);
    out.push(`dar a oportunidade como perdida (${r?.name ?? "motivo"})`);
  }
  if (a.cancel_meetings) out.push("cancelar as reuniões futuras");
  if (a.stage) out.push("mover a oportunidade de etapa");
  if (a.activity) {
    const who = a.activity.assignee.mode === "fixed" && a.activity.assignee.user_id ? (await userNames([a.activity.assignee.user_id])).get(a.activity.assignee.user_id) : "";
    out.push(`criar a atividade "${a.activity.subject}" para ${spLabel(new Date(Date.now() + a.activity.due_hours * 3600_000))}${who ? ` com ${who}` : ""}`);
  }
  if (a.notify_team) out.push("avisar a equipe");
  out.push("registrar o motivo no histórico da oportunidade");
  if (a.stop_followup || a.turn_off_ai) out.push("parar o follow-up");
  if (a.turn_off_ai) out.push("desligar a MAVI nesta conversa");
  return out;
}
