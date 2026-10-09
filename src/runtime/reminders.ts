import { config } from "../config.js";
import { categoryOf, countryOf, recordCost, wabaPrice } from "../costs/ledger.js";
import { db } from "../db.js";
import { addPrivateNote, userNames } from "../integrations/deals.js";
import type { ActionDebug } from "../integrations/debug.js";
import { sendTeamNotice } from "../integrations/index.js";
import { spLabel, spMinutes, spYmd } from "../integrations/time.js";
import { chatWithFallback, type ChatMessage } from "../llm/client.js";
import { log } from "../log.js";
import { conversationAiOn, inboxType, listTemplates, sendMessage, sendTemplate, wabaWindowOpen } from "../makecrm/client.js";
import { agentKeys } from "../secrets.js";
import type { MeetingRemindersT, ReminderStepT } from "../spec/reminders.js";
import type { TeamNotifyConfig } from "../spec/integrations.js";
import { nextOpening } from "./followup.js";
import { cleanText, typingDelayMs } from "./output.js";
import { buildSystemPrompt, contextBlock } from "./prompt.js";
import { integrationCtx, meetingLine, publishedSpec, type ConversationRow } from "./turn.js";

/**
 * Régua de pré-reunião (meeting_reminders): a cada minuto, as etapas vencidas
 * das reuniões marcadas pelo agente entram na fila; cada uma sai uma vez por
 * reunião e horário (meeting_reminder_log). Remarcou: vale o novo horário.
 * Cancelou: para. Lembretes curtos (menos de 1 hora antes) saem mesmo fora da
 * janela de envio; os outros esperam a abertura (se ainda der antes da reunião).
 */

export type MeetingRow = {
  id: string;
  agent_id: string;
  conversation_id: string;
  host_user_id: string;
  starts_at: Date;
  ends_at: Date;
  link: string | null;
  status: string;
  confirmation: string;
  confirmation_alerted: boolean;
  created_at: Date;
  updated_at: Date;
  /** Quando foi marcada (ou remarcada) para o horário atual. */
  scheduled_at: Date;
};

/** Mais que isto de atraso, a etapa é pulada (a fila parou, a reunião foi marcada em cima…). */
const LATE_MS = 30 * 60_000;
/** Lembretes com menos que isto antes da reunião ignoram a janela de envio. */
const SHORT_BEFORE_MIN = 60;

/** Quando a etapa sai: antes do início ou depois do fim, ajustada à janela de envio. */
export function stepDue(step: ReminderStepT, m: Pick<MeetingRow, "starts_at" | "ends_at">, window: MeetingRemindersT["window"]): Date | null {
  const raw = step.when === "before" ? new Date(m.starts_at.getTime() - step.minutes * 60_000) : new Date(m.ends_at.getTime() + step.minutes * 60_000);
  if (!window || (step.when === "before" && step.minutes < SHORT_BEFORE_MIN)) return raw;
  const open = nextOpening(window, raw);
  // Antes da reunião: só se a abertura ainda cair antes do início (com folga); senão, a etapa não sai.
  if (step.when === "before" && open.getTime() > m.starts_at.getTime() - 5 * 60_000) return null;
  return open;
}

/** O que fazer com a etapa agora: enviar, pular (com o motivo) ou esperar. */
export function stepState(
  step: ReminderStepT,
  m: Pick<MeetingRow, "starts_at" | "ends_at" | "scheduled_at">,
  window: MeetingRemindersT["window"],
  now = new Date(),
): { action: "send" } | { action: "skip"; reason: string } | { action: "wait" } {
  const due = stepDue(step, m, window);
  if (!due) return { action: "skip", reason: "o horário da etapa cai fora da janela de envio e não há abertura antes da reunião" };
  if (due.getTime() > now.getTime()) return { action: "wait" };
  // Marcada (ou remarcada) depois do momento desta etapa: não manda atrasado.
  if (due.getTime() < m.scheduled_at.getTime() - 60_000) return { action: "skip", reason: "a reunião foi marcada depois do momento desta etapa" };
  if (step.when === "before" && now.getTime() >= m.starts_at.getTime()) return { action: "skip", reason: "a reunião já começou" };
  if (now.getTime() - due.getTime() > LATE_MS) return { action: "skip", reason: "a etapa venceu há mais de 30 minutos" };
  return { action: "send" };
}

const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const hhmm = (d: Date) => {
  const m = spMinutes(d);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? vars[k]! : all));

/** As variáveis das mensagens da régua. */
export function reminderVars(input: { contactName: string | null; agent: string; company: string; host: string; meeting: Pick<MeetingRow, "starts_at" | "link"> }) {
  const ymd = spYmd(input.meeting.starts_at);
  return {
    nome: input.contactName ?? "",
    primeiro_nome: (input.contactName ?? "").split(/\s+/)[0] ?? "",
    agente: input.agent,
    empresa: input.company,
    anfitriao: input.host,
    data: `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`,
    hora: hhmm(input.meeting.starts_at),
    dia_semana: WEEKDAYS[new Date(`${ymd}T12:00:00-03:00`).getUTCDay()]!,
    link: input.meeting.link ?? "",
  };
}

const stepLabel = (s: ReminderStepT) => {
  const t = s.minutes % 1440 === 0 ? `${s.minutes / 1440} dia(s)` : s.minutes % 60 === 0 ? `${s.minutes / 60} h` : `${s.minutes} min`;
  return s.when === "before" ? `${t} antes` : `${t} depois`;
};

/** Uma etapa da régua (com a trava da conversa, na fila das respostas). */
export async function processReminder(meetingId: string, stepId: string, startsAtIso: string): Promise<string> {
  const sql = db();
  const [m] = await sql<MeetingRow[]>`select * from public.agent_meetings where id = ${meetingId}`;
  if (!m || m.status !== "scheduled" || m.starts_at.toISOString() !== startsAtIso) return "ignorada (reunião mudou)";
  const [conv] = await sql<ConversationRow[]>`select * from public.conversations where id = ${m.conversation_id}`;
  const published = await publishedSpec(m.agent_id);
  const cfg = published?.spec.meeting_reminders;
  const step = cfg?.enabled ? cfg.steps.find((s) => s.id === stepId) : undefined;
  if (!conv || conv.simulation || !published || !cfg || !step) return "ignorada (régua desligada)";
  const spec = published.spec;
  // Uma vez por reunião, etapa e horário.
  const [claim] = await sql<{ id: string }[]>`
    insert into public.meeting_reminder_log (meeting_id, step_id, starts_at) values (${m.id}, ${step.id}, ${m.starts_at})
    on conflict do nothing returning id`;
  if (!claim) return "já enviada";
  const finish = (status: "sent" | "skipped" | "failed", note: string | null, turnId: string | null = null) =>
    sql`update public.meeting_reminder_log set status = ${status}, note = ${note}, turn_id = ${turnId}, updated_at = now() where id = ${claim.id}`;

  const state = stepState(step, m, cfg.window);
  if (state.action === "skip") {
    await finish("skipped", state.reason);
    return "pulada";
  }
  if (cfg.when_ai_off === "skip" && !(await conversationAiOn(conv.external_id))) {
    await finish("skipped", "a IA está desligada nesta conversa (uma pessoa assumiu)");
    return "pulada";
  }

  const ctx = await integrationCtx(conv, spec);
  const host = (await userNames([m.host_user_id]).catch(() => new Map<string, string>())).get(m.host_user_id) ?? "";
  const vars = reminderVars({ contactName: conv.contact_name, agent: spec.persona.name, company: spec.persona.company, host, meeting: m });
  const type = ctx.inboxId ? await inboxType(ctx.inboxId) : null;
  const closed = type === 2 && !(await wabaWindowOpen(conv.external_id));
  const [turn] = await sql<{ id: string }[]>`select gen_random_uuid() as id`;
  const turnId = turn!.id;
  const meetingLabel = spLabel(m.starts_at);
  let texts: string[] = [];
  let usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 };
  let model: string | null = null;
  let note = "";

  try {
    if (closed) {
      if (!step.template) note = "janela de 24h fechada e etapa sem modelo aprovado: pulada";
      else {
        const tpl = (await listTemplates(conv.company_id)).find((t) => t.template_id === step.template!.template_id);
        if (!tpl) note = "modelo aprovado não encontrado no MakeCRM: pulada";
        else {
          const params = step.template.params.map((p) => fill(p, vars));
          await sendTemplate({ companyId: conv.company_id, conversationId: conv.external_id, inboxId: ctx.inboxId!, maviUserId: conv.mavi_user_id, template: tpl, params });
          texts = [`[modelo ${tpl.name}] ${params.join(" · ")}`];
          const country = countryOf(conv.phone);
          const category = categoryOf(tpl.category);
          await recordCost({
            agentId: conv.agent_id,
            conversationId: conv.id,
            turnId,
            source: "waba_template",
            units: 1,
            costUsd: await wabaPrice(country, category).catch(() => 0),
            meta: { template: tpl.name, category, country, reminder: step.id },
          });
        }
      }
    } else if (step.mode === "fixed") {
      texts = fill(step.text, vars)
        .split(/\n\s*\n/)
        .map((t) => cleanText(t, spec))
        .filter(Boolean)
        .slice(0, 3);
    } else {
      const history = (
        await sql<{ role: "user" | "assistant"; content: string }[]>`
          select role, content from (select id, role, content from public.messages
            where conversation_id = ${conv.id} and role in ('user', 'assistant') order by id desc limit 20) h order by id`
      ).map((x) => ({ role: x.role, content: x.content }) as ChatMessage);
      const when = step.when === "before" ? `A reunião começa em ${stepLabel(step).replace(" antes", "")}.` : `A reunião terminou há ${stepLabel(step).replace(" depois", "")}.`;
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
                `[Instrução do sistema — mensagem automática da régua de pré-reunião, sobre a reunião de ${meetingLabel}. ${when}]\n` +
                "Escreva UMA mensagem curta e natural (no máximo 2 balões, separados por uma linha em branco), sem saudação longa. Responda só com o texto.\n" +
                (step.confirm ? "Peça para o lead confirmar a presença respondendo esta mensagem.\n" : "") +
                (m.link && step.when === "before" ? `Se fizer sentido, inclua o link: ${m.link}\n` : "") +
                (step.text ? `Orientação: ${fill(step.text, vars)}\n` : "") +
                contextBlock({ contactName: conv.contact_name, phone: conv.phone, facts: conv.facts, summary: conv.summary, retrieved: [], meeting: await meetingLine(conv.id) }),
            },
          ],
        },
        spec.model.fallback_model ?? config().FALLBACK_MODEL,
        spec.model.fallback_pricing,
      );
      usage = res.usage;
      model = res.model;
      await recordCost({ agentId: conv.agent_id, conversationId: conv.id, turnId, source: "followup", usage: res.usage, model: res.model, meta: { reminder: step.id } });
      texts = (res.message.content ?? "")
        .split(/\n\s*\n/)
        .map((t) => cleanText(t, spec))
        .filter(Boolean)
        .slice(0, 2);
    }
    if (!closed)
      for (let i = 0; i < texts.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, typingDelayMs(texts[i]!)));
        await sendMessage({ companyId: conv.company_id, userId: conv.mavi_user_id, conversationId: conv.external_id, content: texts[i]! });
      }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error({ meetingId, step: step.id, err }, "pré-reunião: falhou");
    await sql`
      insert into public.turns (id, conversation_id, agent_id, agent_version, status, model, tokens_in, tokens_out, tokens_cached, cost_usd, tools, output, error)
      values (${turnId}, ${conv.id}, ${conv.agent_id}, ${published.version}, 'error', ${model}, ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd},
              ${sql.json([toolEntry(step, meetingLabel, err, { outcome: "error", code: "reminder_failed", summary: `Lembrete "${stepLabel(step)}" falhou: ${err}`.slice(0, 400) })] as never)},
              ${sql.json({ reminder: step.id } as never)}, ${`Pré-reunião (${stepLabel(step)}): ${err}`.slice(0, 2000)})`;
    await finish("failed", err.slice(0, 500), turnId);
    return "falhou";
  }

  const sent = texts.length > 0 && !note;
  const debug: ActionDebug = sent
    ? { outcome: "ok", code: "reminder_sent", summary: `Lembrete "${stepLabel(step)}" da reunião de ${meetingLabel} enviado${step.confirm ? " (pediu confirmação)" : ""}.` }
    : { outcome: "empty", code: closed ? "reminder_no_template" : "reminder_skipped", summary: `Lembrete "${stepLabel(step)}" não saiu: ${note || "mensagem vazia"}.`, hint: closed ? "Escolha um modelo aprovado nesta etapa para a caixa oficial (janela de 24h fechada)." : undefined };
  await sql.begin(async (tx) => {
    for (const t of texts)
      await tx`insert into public.messages (conversation_id, role, content, turn_id, meta) values (${conv.id}, 'assistant', ${t}, ${turnId}, ${tx.json({ reminder: step.id } as never)})`;
    await tx`
      insert into public.turns (id, conversation_id, agent_id, agent_version, status, model, tokens_in, tokens_out, tokens_cached, cost_usd, tools, output)
      values (${turnId}, ${conv.id}, ${conv.agent_id}, ${published.version}, ${sent ? "done" : "skipped"}, ${model},
              ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd},
              ${tx.json([toolEntry(step, meetingLabel, texts.join("\n\n") || note, debug)] as never)},
              ${tx.json({ reminder: step.id, messages: texts.map((t) => ({ text: t, media: [] })), note: note || null } as never)})`;
    if (sent) await tx`update public.conversations set last_reply_at = now() where id = ${conv.id}`;
    if (sent && step.confirm) await tx`update public.agent_meetings set confirmation = 'asked', confirmation_at = now() where id = ${m.id} and confirmation = 'none'`;
  });
  await finish(sent ? "sent" : "skipped", note || null, turnId);
  return sent ? "enviada" : "pulada";
}

const toolEntry = (step: ReminderStepT, meeting: string, result: string, debug: ActionDebug) => ({
  name: "lembrete_reuniao",
  args: { etapa: stepLabel(step), reuniao: meeting, ...(step.confirm ? { confirmacao: true } : {}) },
  result: result.slice(0, 2000),
  ms: 0,
  debug,
});

/** Sem confirmação até X minutos antes: avisa a equipe (uma vez por reunião e horário). */
export async function confirmationAlert(m: MeetingRow): Promise<boolean> {
  const sql = db();
  const published = await publishedSpec(m.agent_id);
  const cfg = published?.spec.meeting_reminders;
  const minutes = cfg?.enabled ? cfg.confirmation.alert_minutes_before : null;
  if (!published || !minutes || m.confirmation !== "asked" || m.confirmation_alerted) return false;
  if (Date.now() < m.starts_at.getTime() - minutes * 60_000 || Date.now() >= m.starts_at.getTime()) return false;
  const [claimed] = await sql`update public.agent_meetings set confirmation_alerted = true where id = ${m.id} and not confirmation_alerted returning id`;
  if (!claimed) return false;
  const [conv] = await sql<ConversationRow[]>`select * from public.conversations where id = ${m.conversation_id}`;
  if (!conv) return false;
  const ctx = await integrationCtx(conv, published.spec);
  const text = `O lead ainda não confirmou a reunião de ${spLabel(m.starts_at)}.`;
  const notify = published.spec.integrations.find((i) => i.type === "team_notify" && i.enabled) as TeamNotifyConfig | undefined;
  if (notify) await sendTeamNotice(notify, text, ctx).catch((e) => log.warn({ err: String(e) }, "pré-reunião: aviso de confirmação falhou"));
  if (ctx.inboxId && ctx.makecrmConversationId) await addPrivateNote(ctx.makecrmConversationId, ctx.inboxId, `${text} (régua de pré-reunião da MAVI)`).catch(() => {});
  return true;
}
