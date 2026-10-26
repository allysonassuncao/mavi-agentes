import { config } from "../config.js";
import { categoryOf, countryOf, recordCost, wabaPrice } from "../costs/ledger.js";
import { db } from "../db.js";
import { activityAssignee, addNote, cancelDealMeetings, conversationDeals, createActivity, markLost } from "../integrations/deal-actions.js";
import type { ActionDebug } from "../integrations/debug.js";
import { moveDealsTo, sendTeamNotice, type IntegrationCtx } from "../integrations/index.js";
import { CALLBACK_TOOL, CANCEL_CALLBACK_TOOL, callbacksOn, callbacksPrompt } from "../integrations/prompt.js";
import { spDate, spLabel, spMinutes, spYmd } from "../integrations/time.js";
import { chatWithFallback, type ChatMessage, type ToolDef } from "../llm/client.js";
import { log } from "../log.js";
import { conversationAiOn, inboxType, listTemplates, rest, sendTemplate, wabaWindowOpen } from "../makecrm/client.js";
import { deliverMessage } from "./deliver.js";
import { agentKeys } from "../secrets.js";
import type { AgentSpec } from "../spec/agent.js";
import type { CallbackActionsT } from "../spec/callbacks.js";
import type { TeamNotifyConfig } from "../spec/integrations.js";
import type { WeeklyHours } from "../spec/weekly-hours.js";
import { nextOpening } from "./followup.js";
import { cleanText, typingDelayMs } from "./output.js";
import { buildSystemPrompt, contextBlock } from "./prompt.js";
import { startFollowup } from "./followup-track.js";
import { integrationCtx, meetingLine, publishedSpec, type ConversationRow } from "./turn.js";

/**
 * Retornos combinados (spec.callbacks). O agente marca com agendar_retorno
 * quando o lead pede para ser chamado depois (ou aceita a data que ele
 * propôs) e cancela com cancelar_retorno quando o lead retoma o assunto antes.
 * Um retorno marcado por conversa (agent_callbacks); remarcar um combinado
 * conta como adiamento (seq). Na hora, o worker retoma a conversa e faz as
 * ações; depois, confere se o lead respondeu (ações de "sem resposta").
 */

export { CALLBACK_TOOL, CANCEL_CALLBACK_TOOL, callbacksOn, callbacksPrompt };
export const CALLBACK_TOOLS = new Set([CALLBACK_TOOL, CANCEL_CALLBACK_TOOL]);

export type CallbackRow = {
  id: string;
  agent_id: string;
  conversation_id: string;
  due_at: Date;
  status: "scheduled" | "sending" | "done" | "skipped" | "failed" | "canceled";
  agreed: "confirmed" | "suggested";
  source: "agent" | "manual";
  request: string;
  topic: string;
  seq: number;
  created_by: string | null;
  simulation: boolean;
  sent_at: Date | null;
  created_at: Date;
};

// ---------------------------------------------------------------- ferramentas e prompt

export function callbackTools(spec: AgentSpec): ToolDef[] {
  if (!callbacksOn(spec)) return [];
  return [
    {
      type: "function",
      function: {
        name: CALLBACK_TOOL,
        description:
          "Marca (ou remarca) o retorno combinado com o lead: o dia e a hora em que você vai chamá-lo de novo. Use quando o lead pedir para ser chamado depois ou aceitar a data que você propôs. Chamar de novo troca o retorno marcado.",
        parameters: {
          type: "object",
          properties: {
            quando: { type: "string", description: "Data e hora no horário de Brasília, no formato AAAA-MM-DD HH:MM (ex.: 2026-10-28 10:00)." },
            quem_escolheu: {
              type: "string",
              enum: ["lead", "agente"],
              description: "lead: o lead disse o dia e a hora; agente: você escolheu (o lead pediu algo vago, como \"semana que vem\").",
            },
            combinado: {
              type: "string",
              enum: ["confirmado", "sugerido"],
              description: "confirmado: o lead aceitou este dia e hora; sugerido: você propôs e o lead ainda não respondeu.",
            },
            pedido: { type: "string", description: "O que o lead disse, em poucas palavras (ex.: \"pediu para chamar depois do dia 5, quando recebe\")." },
            assunto: { type: "string", description: "O que retomar na hora (ex.: \"enviar a proposta do plano anual\")." },
          },
          required: ["quando", "quem_escolheu", "combinado", "pedido", "assunto"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: CANCEL_CALLBACK_TOOL,
        description: "Cancela o retorno marcado: o lead retomou o assunto antes da data (a conversa seguiu) ou desistiu do retorno.",
        parameters: {
          type: "object",
          properties: { motivo: { type: "string", description: "Por que cancelar, em poucas palavras." } },
          required: ["motivo"],
        },
      },
    },
  ];
}

/** A linha do contexto sobre o retorno marcado com este lead. */
export function callbackLine(cb: Pick<CallbackRow, "due_at" | "agreed" | "request" | "topic">): string {
  return [
    `${spLabel(cb.due_at)} (${cb.agreed === "confirmed" ? "combinado com o lead" : "você sugeriu e o lead ainda não confirmou"})`,
    cb.request && `pedido: ${cb.request}`,
    cb.topic && `retomar: ${cb.topic}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** "2026-10-28 10:00", "2026-10-28T10:00" ou ISO com fuso → a data (sem fuso = Brasília). */
export function parseWhen(input: string): Date | null {
  const s = input.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (local) {
    const hm = `${local[2]!.padStart(2, "0")}:${local[3]}`;
    if (Number(hm.slice(0, 2)) > 23 || Number(hm.slice(3)) > 59) return null;
    const d = spDate(local[1]!, hm);
    return Number.isNaN(d.getTime()) || spYmd(d) !== local[1] ? null : d;
  }
  // Com fuso explícito (Z ou ±hh:mm); sem fuso, o servidor leria no horário dele.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Os horários em que o agente sugere retorno: os do retorno, senão o horário de atendimento. */
export const suggestWindow = (spec: AgentSpec): WeeklyHours | null => spec.callbacks?.window ?? spec.instructions.weekly_hours ?? null;

/**
 * Confere a data pedida: no futuro (5 min ou mais), até max_days, e — quando
 * o agente escolheu — dentro dos horários de sugestão (vai para a abertura
 * seguinte). Devolve a data final ou o motivo da recusa.
 */
export function checkWhen(
  due: Date,
  opts: { chosenBy: "lead" | "agente"; window: WeeklyHours | null; maxDays: number },
  now = new Date(),
): { ok: true; due: Date; adjusted: boolean } | { ok: false; reason: string } {
  if (due.getTime() < now.getTime() + 5 * 60_000) return { ok: false, reason: "O retorno precisa ser pelo menos 5 minutos no futuro." };
  let final = due;
  if (opts.chosenBy === "agente" && opts.window) final = nextOpening(opts.window, due);
  if (final.getTime() > now.getTime() + opts.maxDays * 86_400_000) return { ok: false, reason: `O retorno pode ser marcado até ${opts.maxDays} dias à frente.` };
  return { ok: true, due: final, adjusted: final.getTime() !== due.getTime() };
}

/** O que acontece com um novo pedido de retorno diante do que já está marcado. */
export function planSchedule(
  existing: Pick<CallbackRow, "due_at" | "agreed"> | null,
  due: Date,
): "same" | "adjust" | "postpone" | "new" {
  if (!existing) return "new";
  if (Math.abs(existing.due_at.getTime() - due.getTime()) < 60_000) return "same";
  // A data só tinha sido sugerida (o lead não tinha aceitado): é ajuste, não adiamento.
  return existing.agreed === "suggested" ? "adjust" : "postpone";
}

export async function pendingCallback(conversationId: string): Promise<CallbackRow | null> {
  const [cb] = await db()<CallbackRow[]>`
    select * from public.agent_callbacks where conversation_id = ${conversationId} and status = 'scheduled' limit 1`;
  return cb ?? null;
}

// ---------------------------------------------------------------- ações

const hasActions = (a: CallbackActionsT) =>
  a.turn_off_ai || a.stop_followup || a.cancel_meetings || !!a.lost_reason_id || !!a.stage || !!a.activity || a.note || a.notify_team;

/** O que as ações fariam (simulação e registro). */
export function describeActions(a: CallbackActionsT): string[] {
  const out: string[] = [];
  if (a.activity) out.push(`criar a atividade "${a.activity.subject}"`);
  if (a.stage) out.push("mover a oportunidade de etapa");
  if (a.note) out.push("registrar no histórico da oportunidade");
  if (a.cancel_meetings) out.push("cancelar as reuniões futuras");
  if (a.lost_reason_id) out.push("dar a oportunidade como perdida");
  if (a.notify_team) out.push("avisar a equipe");
  if (a.stop_followup) out.push("parar o follow-up");
  if (a.turn_off_ai) out.push("desligar a MAVI nesta conversa");
  return out;
}

const MOMENT_LABEL = { on_create: "ao registrar", on_due: "na hora", no_reply: "sem resposta", postponed: "adiou de novo" } as const;
export type CallbackMoment = keyof typeof MOMENT_LABEL;

/**
 * Faz as ações de um momento no MakeCRM. Desligar a IA pode ficar para depois
 * do envio (deferTurnOff: o turno desliga quando a resposta sair).
 */
export async function runCallbackActions(
  ctx: IntegrationCtx,
  a: CallbackActionsT,
  opts: { moment: CallbackMoment; cb: Pick<CallbackRow, "id" | "due_at" | "request" | "topic">; deferTurnOff?: boolean },
): Promise<{ done: string[]; turnOffAi: boolean }> {
  const done: string[] = [];
  if (!hasActions(a)) return { done, turnOffAi: false };
  if (ctx.simulation) return { done: describeActions(a).map((d) => `${d} (simulação)`), turnOffAi: false };
  const label = `Retorno combinado (${MOMENT_LABEL[opts.moment]})`;
  const text = [`Retorno: ${spLabel(opts.cb.due_at)}`, opts.cb.request && `O lead: ${opts.cb.request}`, opts.cb.topic && `Retomar: ${opts.cb.topic}`]
    .filter(Boolean)
    .join("\n");
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      done.push(what);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.warn({ agent: ctx.agentId, callback: opts.cb.id, step: what, err }, "retorno: ação falhou");
      done.push(`${what} (falhou: ${err.slice(0, 160)})`);
    }
  };

  const needsDeal = a.cancel_meetings || !!a.lost_reason_id || !!a.stage || !!a.activity || a.note;
  const deals = needsDeal && ctx.makecrmConversationId ? await conversationDeals(ctx.makecrmConversationId, { closed: true }) : [];
  const open = deals.filter((d) => d.status === 1);
  const main = open[0] ?? null;

  if (a.cancel_meetings && !a.lost_reason_id) await step("reuniões futuras canceladas", () => cancelDealMeetings(ctx, open.map((d) => d.id), label));
  if (a.stage && open.length) await step("oportunidade movida de etapa", () => moveDealsTo(ctx, a.stage!.pipeline_id, a.stage!.stage_id, label.toLowerCase(), true));
  if (a.activity && main) {
    const act = a.activity;
    const base = Math.max(Date.now(), opts.cb.due_at.getTime());
    await step(`atividade "${act.subject}" criada`, async () => {
      const userId = await activityAssignee(ctx, main, act.assignee, `callback:${opts.moment}`);
      await createActivity(ctx, main, { typeId: act.type_id, subject: act.subject, description: text, doIn: new Date(base + act.due_hours * 3600_000), userId });
    });
  }
  const record = deals.length ? (open.length ? open : deals.slice(0, 1)).map((d) => d.id) : [];
  if (a.note && record.length) await step("registrado no histórico", () => addNote(ctx, record, label, text));
  if (a.lost_reason_id)
    for (const d of open)
      await step("oportunidade dada como perdida", () =>
        markLost(ctx, d, a.lost_reason_id!, `${label}: ${opts.cb.request || opts.cb.topic}`.slice(0, 500), { cancelMeetings: a.cancel_meetings, completeActivities: a.complete_activities }),
      );
  if (a.notify_team) {
    const nt = ctx.spec.integrations.find((i) => i.enabled && i.type === "team_notify") as TeamNotifyConfig | undefined;
    if (nt) await step("equipe avisada", () => sendTeamNotice(nt, `${label}${ctx.contactName ? ` com ${ctx.contactName}` : ""}\n${text}`, ctx));
    else done.push("avisar a equipe: a integração \"Avisar a equipe\" está desligada");
  }
  if (a.stop_followup || a.turn_off_ai) {
    await db()`update public.conversations set followup_next_at = null, followup_state = 'idle' where id = ${ctx.conversationId}`;
    done.push("follow-up parado");
  }
  if (needsDeal && !deals.length) done.push("sem oportunidade no CRM para as ações na oportunidade");
  if (a.turn_off_ai && !opts.deferTurnOff) await turnOffAi(ctx, done);
  return { done, turnOffAi: a.turn_off_ai && !!opts.deferTurnOff };
}

export async function turnOffAi(ctx: IntegrationCtx, done: string[]) {
  if (ctx.simulation || !ctx.makecrmConversationId) return;
  await rest(`inbox_conversations?id=eq.${encodeURIComponent(ctx.makecrmConversationId)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ ia_actived: false }),
  })
    .then(() => done.push("MAVI desligada nesta conversa"))
    .catch((e) => done.push(`desligar a MAVI falhou: ${String(e).slice(0, 160)}`));
}

const appendActions = (id: string, moment: CallbackMoment, done: string[]) =>
  done.length
    ? db()`update public.agent_callbacks set actions = actions || ${db().json([{ moment, at: new Date().toISOString(), done }] as never)}, updated_at = now() where id = ${id}`
    : Promise.resolve();

// ---------------------------------------------------------------- na conversa (ferramentas do agente)

export type CallbackHit = {
  /** Nota na conversa do motor (o agente não lê notas). */
  note: string;
  /** Desligar a IA depois do envio (ação configurada). */
  turnOffAi: boolean;
};

/** Seq do próximo retorno marcado pelo agente nesta conversa (desde a última vez que a memória foi zerada). */
async function nextSeq(conversationId: string): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    select count(*)::int as n from public.agent_callbacks k join public.conversations c on c.id = k.conversation_id
    where k.conversation_id = ${conversationId} and k.source = 'agent' and k.created_at > coalesce(c.memory_reset_at, '-infinity'::timestamptz)`;
  return (r?.n ?? 0) + 1;
}

export async function runCallbackTool(
  name: string,
  args: Record<string, unknown>,
  ctx: IntegrationCtx,
  turnId: string,
): Promise<{ result: string; debug?: ActionDebug; hit?: CallbackHit }> {
  const spec = ctx.spec;
  if (!callbacksOn(spec)) return { result: "Retornos desligados neste agente." };
  const cfg = spec.callbacks;
  const sql = db();
  const existing = await pendingCallback(ctx.conversationId);

  if (name === CANCEL_CALLBACK_TOOL) {
    const reason = String(args.motivo ?? "").trim().slice(0, 300) || "o lead retomou o assunto";
    if (!existing) return { result: "Não há retorno marcado com este lead. Siga a conversa." };
    await sql`
      update public.agent_callbacks set status = 'canceled', canceled_reason = ${reason}, canceled_by = 'agente', updated_at = now()
      where id = ${existing.id} and status = 'scheduled'`;
    const summary = `Retorno de ${spLabel(existing.due_at)} cancelado: ${reason}.`;
    return {
      result: "Retorno cancelado. Siga a conversa normalmente.",
      debug: { outcome: ctx.simulation ? "simulated" : "ok", code: "callback_canceled", summary },
      hit: { note: summary, turnOffAi: false },
    };
  }

  const raw = parseWhen(String(args.quando ?? ""));
  if (!raw) return { result: "Data inválida. Use AAAA-MM-DD HH:MM no horário de Brasília (ex.: 2026-10-28 10:00) e chame de novo." };
  const chosenBy = args.quem_escolheu === "agente" ? "agente" : "lead";
  const checked = checkWhen(raw, { chosenBy, window: suggestWindow(spec), maxDays: cfg.max_days });
  if (!checked.ok) return { result: `${checked.reason} Combine outra data com o lead.` };
  const due = checked.due;
  const agreed = args.combinado === "sugerido" ? "suggested" : "confirmed";
  const request = String(args.pedido ?? "").trim().slice(0, 500);
  const topic = String(args.assunto ?? "").trim().slice(0, 500);
  const plan = planSchedule(existing, due);
  const when = spLabel(due);
  const adjusted = checked.adjusted ? " (ajustado para dentro do horário de atendimento: proponha este horário ao lead)" : "";

  if (plan === "same" || plan === "adjust") {
    await sql`
      update public.agent_callbacks set due_at = ${due}, agreed = ${agreed}, request = ${request || existing!.request}, topic = ${topic || existing!.topic},
        history = history || ${sql.json([{ at: new Date().toISOString(), from: existing!.due_at.toISOString(), to: due.toISOString(), by: "agente" }] as never)},
        updated_at = now()
      where id = ${existing!.id}`;
    const summary = plan === "same" ? `Retorno de ${when} mantido (${agreed === "confirmed" ? "confirmado" : "sugerido"}).` : `Retorno sugerido ajustado para ${when}.`;
    return {
      result: `Retorno marcado para ${when}${adjusted}. Siga a conversa.`,
      debug: { outcome: ctx.simulation ? "simulated" : "ok", code: "callback_scheduled", summary },
      hit: { note: summary, turnOffAi: false },
    };
  }

  const seq = await nextSeq(ctx.conversationId);
  const row = await sql.begin(async (tx) => {
    if (existing)
      await tx`update public.agent_callbacks set status = 'canceled', canceled_reason = 'remarcado pelo lead', canceled_by = 'agente', updated_at = now()
        where id = ${existing.id} and status = 'scheduled'`;
    const [r] = await tx<CallbackRow[]>`
      insert into public.agent_callbacks (agent_id, conversation_id, due_at, agreed, source, request, topic, seq, simulation, turn_id, created_by)
      values (${ctx.agentId}, ${ctx.conversationId}, ${due}, ${agreed}, 'agent', ${request}, ${topic}, ${seq}, ${ctx.simulation}, ${turnId}, 'agente')
      on conflict do nothing returning *`;
    return r ?? null;
  });
  // Alguém da equipe marcou um retorno nesta conversa no mesmo instante: vale o dela.
  if (!row) return { result: "Já há um retorno marcado com este lead (marcado pela equipe). Siga a conversa sem marcar outro." };

  // Ações: ao registrar e, a partir do N-ésimo pedido, as de "adiou de novo".
  const done: string[] = [];
  let off = false;
  const created = await runCallbackActions(ctx, cfg.on_create, { moment: "on_create", cb: row, deferTurnOff: true });
  done.push(...created.done);
  off ||= created.turnOffAi;
  await appendActions(row.id, "on_create", created.done);
  const postponed = cfg.postponed.enabled && seq >= cfg.postponed.from;
  if (postponed) {
    const p = await runCallbackActions(ctx, cfg.postponed.actions, { moment: "postponed", cb: row, deferTurnOff: true });
    done.push(...p.done);
    off ||= p.turnOffAi;
    await appendActions(row.id, "postponed", p.done);
  }
  if (cfg.followup.during === "pause" && !ctx.simulation)
    await sql`update public.conversations set followup_next_at = null, followup_state = 'idle' where id = ${ctx.conversationId}`;

  const failed = done.some((d) => d.includes("(falhou:"));
  const summary = `Retorno marcado para ${when}${agreed === "suggested" ? " (sugerido)" : ""}${seq > 1 ? ` · ${seq}º pedido de retorno nesta conversa` : ""}${request ? ` (o lead: ${request})` : ""}.`;
  return {
    result: `Retorno marcado para ${when}${adjusted}. Confirme com o lead de forma natural e siga a conversa.`,
    debug: {
      outcome: ctx.simulation ? "simulated" : failed ? "error" : "ok",
      code: failed ? "error" : "callback_scheduled",
      summary,
      ...(done.length ? { details: done } : {}),
      ...(failed ? { hint: "Uma ou mais ações do retorno falharam no MakeCRM; veja o detalhe acima." } : {}),
    },
    hit: { note: `${summary}${done.length ? ` Feito: ${done.join("; ")}.` : ""}`, turnOffAi: off },
  };
}

// ---------------------------------------------------------------- na hora (worker)

const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const hhmm = (d: Date) => {
  const m = spMinutes(d);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? vars[k]! : all));

export function callbackVars(input: { contactName: string | null; agent: string; company: string; due: Date }) {
  const ymd = spYmd(input.due);
  return {
    nome: input.contactName ?? "",
    primeiro_nome: (input.contactName ?? "").split(/\s+/)[0] ?? "",
    agente: input.agent,
    empresa: input.company,
    data: `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`,
    hora: hhmm(input.due),
    dia_semana: WEEKDAYS[new Date(`${ymd}T12:00:00-03:00`).getUTCDay()]!,
  };
}

/** O retorno na hora: o agente retoma a conversa (se for o caso) e as ações de "na hora". */
export async function processCallback(callbackId: string): Promise<string> {
  const sql = db();
  const [claimed] = await sql<CallbackRow[]>`
    update public.agent_callbacks set status = 'sending', updated_at = now()
    where id = ${callbackId} and status = 'scheduled' and not simulation and due_at <= now() + interval '5 seconds'
    returning *`;
  if (!claimed) return "ignorado";
  const cb = claimed;
  const finish = (status: CallbackRow["status"], outcome: string, extra: { sentAt?: Date | null; turnId?: string | null; noReplyDue?: Date | null } = {}) =>
    sql`update public.agent_callbacks set status = ${status}, outcome = ${outcome.slice(0, 1000)}, sent_at = ${extra.sentAt ?? null},
          no_reply_due_at = ${extra.noReplyDue ?? null}, done_turn_id = ${extra.turnId ?? null}, updated_at = now() where id = ${cb.id}`;

  const [conv] = await sql<ConversationRow[]>`select * from public.conversations where id = ${cb.conversation_id}`;
  const published = await publishedSpec(cb.agent_id);
  if (!conv || !published || !callbacksOn(published.spec)) {
    await finish("skipped", "os retornos estão desligados neste agente (ou ele não está publicado)");
    return "pulado";
  }
  const spec = published.spec;
  const cfg = spec.callbacks;
  const ctx = await integrationCtx(conv, spec);
  const vars = callbackVars({ contactName: conv.contact_name, agent: spec.persona.name, company: spec.persona.company, due: cb.due_at });
  const [turn] = await sql<{ id: string }[]>`select gen_random_uuid() as id`;
  const turnId = turn!.id;
  let texts: string[] = [];
  let usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 };
  let model: string | null = null;
  let note = "";
  let error: string | null = null;
  let closedNoTemplate = false;
  // O momento do envio (antes de mandar: resposta do lead que chegar depois disto conta como resposta ao retorno).
  let sentAt: Date | null = null;

  if (cfg.contact !== "team") {
    try {
      const [last] = await sql<{ role: string }[]>`
        select role from public.messages where conversation_id = ${conv.id} and role in ('user', 'assistant') order by id desc limit 1`;
      if (last?.role === "user") {
        // O lead escreveu e a resposta dele ainda vem (ou acabou de sair sem texto): o agente segue a conversa, sem retomada por cima.
        note = "o lead escreveu antes do retorno sair: o agente segue a conversa normalmente";
      } else if (cfg.when_ai_off === "skip" && !(await conversationAiOn(conv.external_id))) {
        note = "a IA está desligada nesta conversa (uma pessoa assumiu): o agente não retomou";
      } else {
        const type = ctx.inboxId ? await inboxType(ctx.inboxId) : null;
        const closed = type === 2 && !(await wabaWindowOpen(conv.external_id));
        if (closed) {
          const tpl = cfg.template ? (await listTemplates(conv.company_id)).find((t) => t.template_id === cfg.template!.template_id) : null;
          if (!cfg.template) note = "janela de 24h fechada e sem modelo aprovado para o retorno";
          else if (!tpl) note = "modelo aprovado do retorno não encontrado no MakeCRM";
          if (!tpl) closedNoTemplate = true;
          else {
            const params = cfg.template!.params.map((p) => fill(p, vars));
            sentAt = new Date();
            await sendTemplate({ companyId: conv.company_id, conversationId: conv.external_id, inboxId: ctx.inboxId!, maviUserId: conv.mavi_user_id, template: tpl, params });
            texts = [`[modelo ${tpl.name}] ${params.join(" · ")}`];
            await recordCost({
              agentId: conv.agent_id,
              conversationId: conv.id,
              turnId,
              source: "waba_template",
              units: 1,
              costUsd: await wabaPrice(countryOf(conv.phone), categoryOf(tpl.category)).catch(() => 0),
              meta: { template: tpl.name, category: categoryOf(tpl.category), country: countryOf(conv.phone), callback: cb.id },
            });
          }
        } else {
          const history = (
            await sql<{ role: "user" | "assistant"; content: string }[]>`
              select role, content from (select id, role, content from public.messages
                where conversation_id = ${conv.id} and role in ('user', 'assistant') order by id desc limit 30) h order by id`
          ).map((x) => ({ role: x.role, content: x.content }) as ChatMessage);
          const late = Date.now() - cb.due_at.getTime() > 2 * 3600_000;
          const res = await chatWithFallback(
            {
              model: spec.model.model ?? config().DEFAULT_MODEL,
              keys: await agentKeys(conv.agent_id),
              pricing: spec.model.pricing,
              maxTokens: 600,
              messages: [
                { role: "system", content: buildSystemPrompt(spec) },
                ...history,
                {
                  role: "user",
                  content:
                    `[Instrução do sistema — retorno combinado para ${spLabel(cb.due_at)}${late ? " (saiu com atraso)" : ""}: ` +
                    (cb.agreed === "confirmed" ? "o lead pediu para ser chamado agora." : "você sugeriu retomar agora e o lead não respondeu à sugestão.") +
                    (cb.request ? ` O lead: ${cb.request}.` : "") +
                    (cb.topic ? ` Retomar: ${cb.topic}.` : "") +
                    "]\nEscreva UMA retomada curta e natural (no máximo 2 balões, separados por uma linha em branco), lembrando de leve o combinado, sem saudação longa e sem repetir o que já disse. " +
                    "Puxe o assunto de onde parou e convide o lead a responder. Responda só com o texto das mensagens.\n" +
                    (cfg.guide ? `Orientação: ${fill(cfg.guide, vars)}\n` : "") +
                    contextBlock({ contactName: conv.contact_name, phone: conv.phone, facts: conv.facts, summary: conv.summary, retrieved: [], meeting: await meetingLine(conv.id) }),
                },
              ],
            },
            spec.model.fallback_model ?? config().FALLBACK_MODEL,
            spec.model.fallback_pricing,
          );
          usage = res.usage;
          model = res.model;
          await recordCost({ agentId: conv.agent_id, conversationId: conv.id, turnId, source: "followup", usage: res.usage, model: res.model, meta: { callback: cb.id } });
          texts = (res.message.content ?? "")
            .split(/\n\s*\n/)
            .map((t) => cleanText(t, spec))
            .filter(Boolean)
            .slice(0, 2);
          if (texts.length) sentAt = new Date();
          for (let i = 0; i < texts.length; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, typingDelayMs(texts[i]!)));
            await deliverMessage({ companyId: conv.company_id, userId: conv.mavi_user_id, conversationId: conv.external_id, content: texts[i]! });
          }
          if (!texts.length) note = "a mensagem de retorno veio vazia";
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log.error({ callbackId: cb.id, err: error }, "retorno: envio falhou");
    }
  }

  const sent = texts.length > 0 && !error;
  // Na hora: as ações configuradas (valem mesmo se a mensagem não saiu).
  const due = await runCallbackActions(ctx, cfg.on_due, { moment: "on_due", cb }).catch((e) => ({ done: [`ações falharam: ${String(e).slice(0, 160)}`], turnOffAi: false }));
  const done = [...due.done];
  // Não saiu pela caixa oficial: a equipe fica sabendo (se a integração estiver ligada e a ação não avisou já).
  if (cfg.contact !== "team" && !sent && (closedNoTemplate || error) && !cfg.on_due.notify_team) {
    const nt = spec.integrations.find((i) => i.enabled && i.type === "team_notify") as TeamNotifyConfig | undefined;
    if (nt)
      await sendTeamNotice(nt, `O retorno combinado${conv.contact_name ? ` com ${conv.contact_name}` : ""} (${spLabel(cb.due_at)}) não saiu: ${error ?? note}. Chame o lead.`, ctx)
        .then(() => done.push("equipe avisada (o retorno não saiu)"))
        .catch(() => {});
  }
  await appendActions(cb.id, "on_due", done);

  const outcome =
    cfg.contact === "team"
      ? `contato com a equipe${done.length ? `: ${done.join("; ")}` : ""}`
      : sent
        ? `mensagem enviada${done.length ? `; ${done.join("; ")}` : ""}`
        : `mensagem não saiu: ${error ?? note}${done.length ? `; ${done.join("; ")}` : ""}`;
  const debug: ActionDebug = sent
    ? { outcome: "ok", code: "callback_sent", summary: `Retorno combinado de ${spLabel(cb.due_at)}: o agente retomou a conversa.`, ...(done.length ? { details: done } : {}) }
    : cfg.contact === "team"
      ? { outcome: "ok", code: "callback_team", summary: `Retorno combinado de ${spLabel(cb.due_at)}: com a equipe.`, ...(done.length ? { details: done } : {}) }
      : {
          outcome: error ? "error" : "empty",
          code: error ? "callback_failed" : closedNoTemplate ? "callback_no_template" : "callback_skipped",
          summary: `Retorno combinado de ${spLabel(cb.due_at)} não saiu: ${error ?? note}.`,
          ...(done.length ? { details: done } : {}),
          ...(closedNoTemplate ? { hint: "Escolha um modelo aprovado em Retornos para a caixa oficial (janela de 24h fechada)." } : {}),
        };

  await sql.begin(async (tx) => {
    for (const t of texts)
      await tx`insert into public.messages (conversation_id, role, content, turn_id, meta) values (${conv.id}, 'assistant', ${t}, ${turnId}, ${tx.json({ callback: cb.id } as never)})`;
    await tx`insert into public.messages (conversation_id, role, content, turn_id) values (${conv.id}, 'note', ${`Retorno combinado (${spLabel(cb.due_at)}): ${outcome}`.slice(0, 2000)}, ${turnId})`;
    await tx`
      insert into public.turns (id, conversation_id, agent_id, agent_version, status, model, tokens_in, tokens_out, tokens_cached, cost_usd, tools, output, error)
      values (${turnId}, ${conv.id}, ${conv.agent_id}, ${published.version}, ${error ? "error" : sent ? "done" : "skipped"}, ${model},
              ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd},
              ${tx.json([{ name: "retorno_combinado", args: { quando: spLabel(cb.due_at), pedido: cb.request, assunto: cb.topic }, result: (texts.join("\n\n") || outcome).slice(0, 2000), ms: 0, debug }] as never)},
              ${tx.json({ callback: cb.id, messages: texts.map((t) => ({ text: t, media: [] })), note: note || null } as never)},
              ${error ? `Retorno combinado: ${error}`.slice(0, 2000) : null})`;
    if (sent) await tx`update public.conversations set last_reply_at = now() where id = ${conv.id}`;
  });
  // A régua: conta a partir da mensagem de retorno (restart) ou fica parada.
  const fu = spec.followup;
  if (sent && cfg.followup.after === "restart" && fu?.enabled && fu.steps.length && !cfg.on_due.stop_followup && !cfg.on_due.turn_off_ai)
    await startFollowup(fu, conv).catch((e) => log.warn({ err: String(e) }, "retorno: follow-up não recomeçou"));
  else if (cfg.followup.after === "stop") await sql`update public.conversations set followup_next_at = null, followup_state = 'idle' where id = ${conv.id}`;

  const status: CallbackRow["status"] = error ? "failed" : sent || cfg.contact === "team" || done.length ? "done" : "skipped";
  await finish(status, outcome, {
    sentAt: sent ? sentAt : null,
    turnId,
    noReplyDue: sent && sentAt && cfg.no_reply.enabled ? new Date(sentAt.getTime() + cfg.no_reply.after_hours * 3600_000) : null,
  });
  return sent ? "enviado" : status;
}

/**
 * Depois do retorno: quem respondeu fica marcado (replied_at); quem não
 * respondeu em X horas recebe as ações de "sem resposta" (uma vez). Só vale
 * para os retornos em que o agente mandou mensagem (sent_at).
 */
export async function callbackRepliesTick(): Promise<number> {
  const sql = db();
  await sql`
    update public.agent_callbacks k set replied_at = m.at, updated_at = now()
    from (
      select k2.id, min(msg.created_at) as at from public.agent_callbacks k2
      join public.messages msg on msg.conversation_id = k2.conversation_id and msg.role = 'user' and msg.created_at > k2.sent_at
      where k2.status = 'done' and k2.sent_at > now() - interval '31 days' and k2.replied_at is null and k2.no_reply_at is null and not k2.simulation
      group by k2.id
    ) m
    where k.id = m.id`;
  // Só os que têm "sem resposta" ligado na hora do envio (no_reply_due_at); desligado depois: só marca.
  const waiting = await sql<(CallbackRow & { sent_at: Date })[]>`
    select * from public.agent_callbacks
    where status = 'done' and replied_at is null and no_reply_at is null and no_reply_due_at <= now() and not simulation
    order by no_reply_due_at limit 200`;
  let n = 0;
  for (const cb of waiting) {
    const published = await publishedSpec(cb.agent_id).catch(() => null);
    const cfg = published && callbacksOn(published.spec) ? published.spec.callbacks : null;
    if (!cfg?.no_reply.enabled) {
      await sql`update public.agent_callbacks set no_reply_at = now(), updated_at = now() where id = ${cb.id} and no_reply_at is null`;
      continue;
    }
    const [claim] = await sql`update public.agent_callbacks set no_reply_at = now(), updated_at = now() where id = ${cb.id} and no_reply_at is null returning id`;
    if (!claim) continue;
    const [conv] = await sql<ConversationRow[]>`select * from public.conversations where id = ${cb.conversation_id}`;
    if (!conv) continue;
    const ctx = await integrationCtx(conv, published!.spec);
    const r = await runCallbackActions(ctx, cfg.no_reply.actions, { moment: "no_reply", cb }).catch((e) => ({ done: [`ações falharam: ${String(e).slice(0, 160)}`], turnOffAi: false }));
    await appendActions(cb.id, "no_reply", r.done);
    await sql`insert into public.messages (conversation_id, role, content) values (${conv.id}, 'note', ${`O lead não respondeu ao retorno combinado em ${cfg.no_reply.after_hours} h${r.done.length ? `: ${r.done.join("; ")}` : ""}.`.slice(0, 2000)})`;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- pela pessoa (aba Retornos)

/** Limite de dias para a pessoa marcar: o da configuração publicada (ou 365). */
export async function maxDaysFor(agentId: string): Promise<number> {
  const p = await publishedSpec(agentId).catch(() => null);
  return p?.spec.callbacks?.max_days ?? 365;
}

export function validManualDue(due: Date, maxDays: number, now = new Date()): string | null {
  if (Number.isNaN(due.getTime())) return "Data inválida.";
  if (due.getTime() < now.getTime() + 60_000) return "Escolha uma data e hora no futuro.";
  if (due.getTime() > now.getTime() + maxDays * 86_400_000) return `O retorno pode ser marcado até ${maxDays} dias à frente.`;
  return null;
}

/** As ações de "ao registrar" para o retorno marcado à mão (com a configuração publicada). */
export async function manualCreated(cb: CallbackRow): Promise<string[]> {
  const published = await publishedSpec(cb.agent_id).catch(() => null);
  if (!published || !callbacksOn(published.spec)) return [];
  const [conv] = await db()<ConversationRow[]>`select * from public.conversations where id = ${cb.conversation_id}`;
  if (!conv) return [];
  const spec = published.spec;
  const ctx = await integrationCtx(conv, spec);
  const r = await runCallbackActions(ctx, spec.callbacks.on_create, { moment: "on_create", cb });
  await appendActions(cb.id, "on_create", r.done);
  if (spec.callbacks.followup.during === "pause")
    await db()`update public.conversations set followup_next_at = null, followup_state = 'idle' where id = ${conv.id}`;
  return r.done;
}
