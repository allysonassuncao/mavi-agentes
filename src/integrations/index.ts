import { config } from "../config.js";
import { db } from "../db.js";
import type { ToolDef } from "../llm/client.js";
import { log } from "../log.js";
import { rest } from "../makecrm/client.js";
import { redis } from "../redis.js";
import type { AgentSpec } from "../spec/agent.js";
import type { ChangeOwnerConfig, GoogleCalendarConfig, Integration, MoveDealConfig, RoleTargetT, TeamNotifyConfig } from "../spec/integrations.js";
import {
  busyTimes,
  CalendarError,
  cancelEvent,
  createEvent,
  freeSlots,
  googleToken,
  moveEvent,
  parseWhen,
  spreadSlots,
  withinAllowed,
} from "./calendar.js";
import { activeDeals, addPrivateNote, addStory, userNames, type Deal } from "./deals.js";
import { availableUsers, commitRotation, pickUser, rotationOrder } from "./rotation.js";
import { addDays, spLabel, spYmd } from "./time.js";

/**
 * As integrações viram ferramentas do agente. Cada uma é executada aqui, pelo
 * motor, direto no Google e no MakeCRM. Nas simulações (aba Testar) nada é
 * gravado: a agenda é lida de verdade, mas marcar, mover e trocar só dizem o
 * que fariam.
 */

export type IntegrationCtx = {
  agentId: string;
  agentName: string;
  spec: AgentSpec;
  simulation: boolean;
  /** Conversa no motor. */
  conversationId: string;
  /** Conversa, caixa, empresa e usuário IA no MakeCRM (vazios na simulação). */
  makecrmConversationId: string | null;
  inboxId: string | null;
  companyId: string;
  maviUserId: string | null;
  contactName: string | null;
  phone: string | null;
  facts: Record<string, unknown>;
  summary: string;
};
export type IntegrationResult = { result: string; silent?: boolean; action?: Record<string, unknown> };

const enabled = (spec: AgentSpec) => spec.integrations.filter((i) => i.enabled);
const get = <T extends Integration["type"]>(spec: AgentSpec, type: T) =>
  enabled(spec).find((i) => i.type === type) as Extract<Integration, { type: T }> | undefined;

// ---------------------------------------------------------------- ferramentas

export function integrationTools(spec: AgentSpec): ToolDef[] {
  const tools: ToolDef[] = [];
  const cal = get(spec, "google_calendar");
  if (cal) {
    tools.push(
      fn("agenda_horarios_livres", "Busca horários livres para a reunião. Use antes de oferecer horários; ofereça 2 ou 3 opções ao lead.", {
        a_partir_de: { type: "string", description: "Data inicial AAAA-MM-DD (opcional; padrão: hoje). Use quando o lead pedir um dia." },
        periodo: { type: "string", enum: ["manha", "tarde", "noite", "qualquer"], description: "Preferência do lead (opcional)." },
      }),
      fn(
        "agenda_marcar",
        `Marca a reunião (${cal.duration_minutes} min). Só depois de o lead confirmar o horário${cal.invite_lead ? "; peça o e-mail para enviar o convite" : ""}.`,
        {
          horario: { type: "string", description: "O código do horário (ex.: H2) ou data e hora AAAA-MM-DD HH:MM (Brasília)." },
          email: { type: "string", description: "E-mail do lead para o convite (opcional)." },
          observacao: { type: "string", description: "Assunto ou observação curta para a descrição (opcional)." },
        },
        ["horario"],
      ),
      fn("agenda_remarcar", "Remarca a reunião já marcada com este lead para outro horário livre.", { horario: { type: "string", description: "Código (H#) ou AAAA-MM-DD HH:MM." } }, ["horario"]),
      fn("agenda_cancelar", "Cancela a reunião marcada com este lead.", { motivo: { type: "string" } }),
    );
  }
  const mv = get(spec, "makecrm_move_deal");
  if (mv) {
    tools.push(
      fn(
        "mover_oportunidade",
        `Move a oportunidade do lead no funil do CRM quando a situação combinar com uma regra. Ação interna: não comente com o lead. Regras:\n${mv.rules.map((r) => `- ${r.id}: ${r.when}`).join("\n")}`,
        { regra: { type: "string", enum: mv.rules.map((r) => r.id) }, motivo: { type: "string", description: "Em poucas palavras, o que o lead disse." } },
        ["regra"],
      ),
    );
  }
  const ow = get(spec, "makecrm_change_owner");
  if (ow) {
    tools.push(
      fn(
        "trocar_responsavel",
        `Troca o responsável (proprietário, SDR ou closer) da oportunidade quando a situação combinar com uma regra. Ação interna: não comente com o lead. Regras:\n${ow.rules.map((r) => `- ${r.id}: ${r.when}`).join("\n")}`,
        { regra: { type: "string", enum: ow.rules.map((r) => r.id) }, motivo: { type: "string" } },
        ["regra"],
      ),
    );
  }
  const nt = get(spec, "team_notify");
  if (nt) {
    tools.push(
      fn("avisar_equipe", `Avisa a equipe pelo WhatsApp. Quando: ${nt.when}. Ação interna: não comente com o lead.`, {
        mensagem: { type: "string", description: "O aviso, curto e objetivo (o que aconteceu e o que a equipe precisa fazer)." },
      }, ["mensagem"]),
    );
  }
  return tools;
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export const INTEGRATION_TOOL_NAMES = new Set([
  "agenda_horarios_livres",
  "agenda_marcar",
  "agenda_remarcar",
  "agenda_cancelar",
  "mover_oportunidade",
  "trocar_responsavel",
  "avisar_equipe",
]);

export async function runIntegrationTool(name: string, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  try {
    switch (name) {
      case "agenda_horarios_livres":
        return await searchSlots(need(get(ctx.spec, "google_calendar")), args, ctx);
      case "agenda_marcar":
        return await schedule(need(get(ctx.spec, "google_calendar")), args, ctx);
      case "agenda_remarcar":
        return await reschedule(need(get(ctx.spec, "google_calendar")), args, ctx);
      case "agenda_cancelar":
        return await cancel(need(get(ctx.spec, "google_calendar")), args, ctx);
      case "mover_oportunidade":
        return await moveDeal(need(get(ctx.spec, "makecrm_move_deal")), args, ctx);
      case "trocar_responsavel":
        return await changeOwner(need(get(ctx.spec, "makecrm_change_owner")), args, ctx);
      case "avisar_equipe":
        return await notifyTeam(need(get(ctx.spec, "team_notify")), args, ctx);
      default:
        return { result: "Ferramenta não disponível." };
    }
  } catch (e) {
    const msg = e instanceof CalendarError ? e.message : "Não consegui concluir agora.";
    log.warn({ tool: name, agent: ctx.agentId, err: e instanceof Error ? e.message : String(e) }, "integração falhou");
    await recordFailure(name, e, ctx).catch((err) => log.warn({ err: String(err) }, "integração: falha não registrada"));
    return { result: `Não deu certo: ${msg} Diga ao lead, com naturalidade, que vai confirmar e retornar; não invente que deu certo.` };
  }
}

// ---------------------------------------------------------------- falhas

const INTEGRATION_OF: Record<string, string> = {
  agenda_horarios_livres: "google_calendar",
  agenda_marcar: "google_calendar",
  agenda_remarcar: "google_calendar",
  agenda_cancelar: "google_calendar",
  mover_oportunidade: "makecrm_move_deal",
  trocar_responsavel: "makecrm_change_owner",
  avisar_equipe: "team_notify",
};
const INTEGRATION_LABEL: Record<string, string> = {
  google_calendar: "Google Agenda",
  makecrm_move_deal: "Mover oportunidade",
  makecrm_change_owner: "Trocar responsável",
  team_notify: "Avisar a equipe",
};
/** Uma falha avisa a equipe no máximo uma vez a cada 6 horas (por agente, integração e motivo). */
const NOTIFY_EVERY_HOURS = 6;

/**
 * Registra a falha de uma integração numa conversa real (o construtor mostra
 * o alerta) e avisa a equipe pela integração "Avisar a equipe", se ligada.
 */
export async function recordFailure(tool: string, e: unknown, ctx: IntegrationCtx): Promise<void> {
  if (ctx.simulation) return;
  const integration = INTEGRATION_OF[tool] ?? tool;
  const code = e instanceof CalendarError ? e.code : "error";
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
  const sql = db();
  const [recent] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.integration_failures
    where agent_id = ${ctx.agentId} and integration = ${integration} and code = ${code} and notified
      and created_at > now() - make_interval(hours => ${NOTIFY_EVERY_HOURS})`;
  const notify = integration !== "team_notify" ? get(ctx.spec, "team_notify") : undefined;
  const willNotify = !!notify && !recent!.n;
  await sql`
    insert into public.integration_failures (agent_id, conversation_id, integration, tool, code, message, notified)
    values (${ctx.agentId}, ${ctx.conversationId}, ${integration}, ${tool}, ${code}, ${message}, ${willNotify})`;
  if (willNotify)
    await sendTeamNotice(
      notify!,
      `⚠️ A integração ${INTEGRATION_LABEL[integration] ?? integration} falhou nesta conversa: ${message}\nO agente disse ao lead que a equipe vai confirmar. Corrija em MAVI Tasks › Agentes MAVI › Integrações.`,
      ctx,
    );
}

function need<T>(v: T | undefined): T {
  if (!v) throw new Error("Integração desligada.");
  return v;
}

// ---------------------------------------------------------------- agenda

type StoredSlot = { start: string; end: string; host: string };
const slotsKey = (conv: string) => `cal:slots:${conv}`;

/** Os anfitriões na ordem de preferência agora (com o Google conectado). */
async function hostOrder(cfg: GoogleCalendarConfig, ctx: IntegrationCtx) {
  const base = cfg.distribution === "fixed" ? cfg.hosts.slice(0, 1) : cfg.hosts;
  const available = cfg.distribution === "fixed" ? base : await availableUsers(base);
  return cfg.distribution === "fixed" ? base : rotationOrder(ctx.agentId, "calendar", available.length ? available : base);
}

async function searchSlots(cfg: GoogleCalendarConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const today = spYmd(new Date());
  const asked = typeof args.a_partir_de === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.a_partir_de) ? args.a_partir_de : today;
  const from = asked < today ? today : asked;
  const lastDay = addDays(today, cfg.days_ahead);
  if (from > lastDay) return { result: `Só consigo marcar até ${cfg.days_ahead} dias à frente. Ofereça uma data mais próxima.` };
  const days = Math.max(1, Math.min(cfg.days_ahead, Math.round((Date.parse(lastDay) - Date.parse(from)) / 86_400_000) + 1));
  const period = typeof args.periodo === "string" && args.periodo !== "qualquer" ? args.periodo : null;

  // Uma agenda com problema não derruba as outras; se nenhuma der certo, a
  // falha sobe (e é registrada uma vez em runIntegrationTool).
  const failures: unknown[] = [];
  let read = 0;
  for (const host of await hostOrder(cfg, ctx)) {
    const token = await googleToken(ctx.companyId, host.user_id);
    if (!token) {
      failures.push(new CalendarError("A agenda do anfitrião não está conectada no MakeCRM (conecte o Google Agenda dele lá).", "not_connected"));
      continue;
    }
    const start = new Date(`${from}T00:00:00-03:00`);
    const end = new Date(`${addDays(from, days)}T00:00:00-03:00`);
    let busy;
    try {
      busy = await busyTimes(token, start, end);
      read++;
    } catch (e) {
      failures.push(e);
      continue;
    }
    const slots = spreadSlots(freeSlots(cfg, busy, from, days), 6, period);
    if (!slots.length) continue;
    // Achou com este anfitrião: as agendas com problema ficam registradas.
    for (const f of failures) await recordFailure("agenda_horarios_livres", f, ctx).catch(() => {});
    const stored: Record<string, StoredSlot> = {};
    const lines = slots.map((s, i) => {
      stored[`H${i + 1}`] = { start: s.start.toISOString(), end: s.end.toISOString(), host: host.user_id };
      return `H${i + 1}: ${spLabel(s.start)}`;
    });
    await redis().set(slotsKey(ctx.conversationId), JSON.stringify(stored), "EX", 86_400);
    return { result: `Horários livres (${cfg.duration_minutes} min):\n${lines.join("\n")}\nOfereça 2 ou 3 destes ao lead.` };
  }
  // Nenhuma agenda lida: é falha (registrada e avisada), não "sem horários".
  if (!read && failures.length) throw failures[0];
  for (const f of failures) await recordFailure("agenda_horarios_livres", f, ctx).catch(() => {});
  return {
    result: cfg.hosts.length ? "Não há horários livres no período. Ofereça outro dia ou diga que a equipe vai retornar." : "Nenhum anfitrião configurado.",
  };
}

async function slotFor(cfg: GoogleCalendarConfig, value: string, ctx: IntegrationCtx): Promise<StoredSlot | string> {
  const code = value.trim().toUpperCase();
  const raw = await redis().get(slotsKey(ctx.conversationId));
  const stored = raw ? (JSON.parse(raw) as Record<string, StoredSlot>) : {};
  if (/^H\d+$/.test(code)) return stored[code] ?? "Esse horário não está mais na lista: busque os horários livres de novo.";
  const start = parseWhen(value);
  if (!start) return "Horário inválido: use o código (H1…) ou AAAA-MM-DD HH:MM.";
  const end = new Date(start.getTime() + cfg.duration_minutes * 60_000);
  if (start.getTime() < Date.now() + cfg.min_notice_minutes * 60_000) return "Esse horário é cedo demais. Busque os horários livres.";
  if (!withinAllowed(cfg, start, end)) return "Esse horário está fora dos dias/horários de agendamento. Busque os horários livres.";
  // Confere se está livre com o anfitrião da vez.
  let connected = 0;
  for (const host of await hostOrder(cfg, ctx)) {
    const token = await googleToken(ctx.companyId, host.user_id);
    if (!token) continue;
    connected++;
    const busy = await busyTimes(token, start, end);
    if (!busy.some((b) => start.getTime() < b.end && end.getTime() > b.start)) return { start: start.toISOString(), end: end.toISOString(), host: host.user_id };
  }
  if (!connected) throw new CalendarError("A agenda do anfitrião não está conectada no MakeCRM (conecte o Google Agenda dele lá).", "not_connected");
  return "Esse horário não está livre. Busque os horários livres e ofereça outro.";
}

function leadEmail(args: Record<string, unknown>, ctx: IntegrationCtx): string | null {
  const v = String(args.email ?? ctx.facts["e-mail"] ?? ctx.facts.email ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

async function schedule(cfg: GoogleCalendarConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const slot = await slotFor(cfg, String(args.horario ?? ""), ctx);
  if (typeof slot === "string") return { result: slot };
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const email = cfg.invite_lead ? leadEmail(args, ctx) : null;
  const lead = ctx.contactName || ctx.phone || "lead";
  const title = cfg.title.replaceAll("{lead}", lead).replaceAll("{agente}", ctx.agentName).slice(0, 200);
  if (ctx.simulation) {
    return { result: `Simulação: a reunião seria marcada para ${spLabel(start)}${email ? ` com convite para ${email}` : ""}. Confirme ao lead normalmente.`, action: { type: "agenda_marcar", start: slot.start, host: slot.host, simulation: true } };
  }
  const token = await googleToken(ctx.companyId, slot.host);
  if (!token) throw new CalendarError("A agenda do anfitrião não está conectada no MakeCRM (conecte o Google Agenda dele lá).", "not_connected");
  const description = [
    String(args.observacao ?? "").trim(),
    `Lead: ${lead}${ctx.phone ? ` (${ctx.phone})` : ""}`,
    cfg.add_summary && ctx.summary ? `Resumo da conversa:\n${ctx.summary}` : "",
    "Marcada pela MAVI.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const ev = await createEvent(token, { start, end, title, description, attendee: email, meet: cfg.meet_link });
  if (cfg.distribution === "round_robin") await commitRotation(ctx.agentId, "calendar", cfg.hosts, slot.host);
  await redis().del(slotsKey(ctx.conversationId));

  const deals = ctx.makecrmConversationId ? await activeDeals(ctx.makecrmConversationId).catch(() => [] as Deal[]) : [];
  for (const d of deals) {
    await rest("pipeline_deal_meets", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        deal_id: d.id,
        user_id: slot.host,
        type: "schedule",
        title,
        event_id: ev.id,
        start: slot.start,
        end: slot.end,
        attendees: email ? [email] : [],
        description,
        link: ev.link,
        status: true,
      }),
    }).catch((e) => log.warn({ err: String(e) }, "agenda: não registrou a reunião na oportunidade"));
    await addStory(d.id, ctx.maviUserId, `<strong>Reunião agendada pela MAVI</strong><br/>Data: ${spLabel(start)}${ev.link ? `<br/>Link: ${ev.link}` : ""}${email ? `<br/>Participante: ${email}` : ""}`).catch(() => {});
  }
  if (!deals.length && ctx.makecrmConversationId && ctx.inboxId)
    await addPrivateNote(ctx.makecrmConversationId, ctx.inboxId, `A MAVI marcou uma reunião para ${spLabel(start)}${ev.link ? ` — ${ev.link}` : ""}.`).catch(() => {});
  await db()`
    insert into public.agent_meetings (agent_id, conversation_id, company_id, host_user_id, calendar_id, event_id, starts_at, ends_at, link, attendee_email, deal_ids)
    values (${ctx.agentId}, ${ctx.conversationId}, ${ctx.companyId}, ${slot.host}, ${ev.calendarId}, ${ev.id}, ${slot.start}, ${slot.end}, ${ev.link}, ${email}, ${deals.map((d) => d.id)})`;
  return {
    result: `Reunião marcada para ${spLabel(start)}.${ev.link ? ` Link: ${ev.link}` : ""}${email ? ` Convite enviado para ${email}.` : ""} Confirme ao lead.`,
    action: { type: "agenda_marcar", start: slot.start, host: slot.host, event_id: ev.id },
  };
}

async function currentMeeting(ctx: IntegrationCtx) {
  const [m] = await db()<{ id: string; host_user_id: string; event_id: string; starts_at: Date; ends_at: Date; attendee_email: string | null; deal_ids: string[] }[]>`
    select id, host_user_id, event_id, starts_at, ends_at, attendee_email, deal_ids from public.agent_meetings
    where conversation_id = ${ctx.conversationId} and status = 'scheduled' and ends_at > now()
    order by starts_at limit 1`;
  return m ?? null;
}

async function reschedule(cfg: GoogleCalendarConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const m = ctx.simulation ? null : await currentMeeting(ctx);
  if (!m && !ctx.simulation) return { result: "Não há reunião marcada por mim com este lead. Para marcar, use agenda_marcar." };
  const slot = await slotFor(cfg, String(args.horario ?? ""), ctx);
  if (typeof slot === "string") return { result: slot };
  if (ctx.simulation) return { result: `Simulação: a reunião seria remarcada para ${spLabel(new Date(slot.start))}.` };
  if (slot.host !== m!.host_user_id) {
    // O novo horário veio de outro anfitrião: confere na agenda do anfitrião original.
    const token = await googleToken(ctx.companyId, m!.host_user_id);
    if (!token) return { result: "A agenda do anfitrião não está conectada. Diga que a equipe vai confirmar." };
    const busy = await busyTimes(token, new Date(slot.start), new Date(slot.end));
    if (busy.length) return { result: "Esse horário não está livre com quem vai conduzir a reunião. Ofereça outro." };
  }
  const token = await googleToken(ctx.companyId, m!.host_user_id);
  if (!token) return { result: "A agenda do anfitrião não está conectada. Diga que a equipe vai confirmar." };
  await moveEvent(token, m!.event_id, new Date(slot.start), new Date(slot.end), !!m!.attendee_email);
  await rest(`pipeline_deal_meets?event_id=eq.${encodeURIComponent(m!.event_id)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ start: slot.start, end: slot.end }),
  }).catch(() => {});
  for (const d of m!.deal_ids) await addStory(d, ctx.maviUserId, `<strong>Reunião remarcada pela MAVI</strong><br/>Nova data: ${spLabel(new Date(slot.start))}`).catch(() => {});
  await db()`update public.agent_meetings set starts_at = ${slot.start}, ends_at = ${slot.end}, updated_at = now() where id = ${m!.id}`;
  await redis().del(slotsKey(ctx.conversationId));
  return { result: `Reunião remarcada para ${spLabel(new Date(slot.start))}. Confirme ao lead.` };
}

async function cancel(_cfg: GoogleCalendarConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  if (ctx.simulation) return { result: "Simulação: a reunião seria cancelada." };
  const m = await currentMeeting(ctx);
  if (!m) return { result: "Não há reunião marcada por mim com este lead." };
  const token = await googleToken(ctx.companyId, m.host_user_id);
  if (token) await cancelEvent(token, m.event_id, !!m.attendee_email);
  await rest(`pipeline_deal_meets?event_id=eq.${encodeURIComponent(m.event_id)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ status: false }),
  }).catch(() => {});
  const motivo = String(args.motivo ?? "").trim();
  for (const d of m.deal_ids) await addStory(d, ctx.maviUserId, `<strong>Reunião cancelada pela MAVI</strong>${motivo ? `<br/>Motivo: ${motivo}` : ""}`).catch(() => {});
  await db()`update public.agent_meetings set status = 'canceled', updated_at = now() where id = ${m.id}`;
  return { result: "Reunião cancelada. Avise o lead." };
}

// ---------------------------------------------------------------- oportunidade

async function moveDeal(cfg: MoveDealConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const rule = cfg.rules.find((r) => r.id === String(args.regra ?? ""));
  if (!rule) return { result: "Regra desconhecida.", silent: true };
  if (ctx.simulation) {
    const stage = await stageOf(rule.pipeline_id, rule.stage_id);
    return { result: stage ? `Simulação: a oportunidade iria para a etapa "${stage.name}". Siga a conversa sem comentar.` : "A etapa da regra não existe mais no CRM.", silent: true };
  }
  // Uma vez por regra e conversa a cada hora (o lead pode repetir a mesma coisa).
  const dedup = `mv:${ctx.conversationId}:${rule.id}`;
  if (!(await redis().set(dedup, "1", "EX", 3600, "NX"))) return { result: "Já feito.", silent: true };
  const r = await moveDealsTo(ctx, rule.pipeline_id, rule.stage_id, args.motivo ? String(args.motivo) : "", cfg.run_automations);
  return { ...r, silent: true, action: { type: "mover_oportunidade", rule: rule.id } };
}

async function stageOf(pipelineId: string, stageId: string) {
  return (
    await rest<{ id: string; name: string; pipeline_id: string }[]>(
      `pipeline_stages?select=id,name,pipeline_id&id=eq.${stageId}&pipeline_id=eq.${pipelineId}&status=eq.true`,
    )
  )[0];
}

/** Move as oportunidades ativas da conversa para a etapa (histórico, log e automações do MakeCRM). */
export async function moveDealsTo(ctx: IntegrationCtx, pipelineId: string, stageId: string, reason: string, runAutomations: boolean): Promise<IntegrationResult> {
  const stage = await stageOf(pipelineId, stageId);
  if (!stage) return { result: "A etapa não existe mais no CRM (avise a equipe para corrigir a configuração)." };
  if (!ctx.makecrmConversationId) return { result: "Sem conversa no CRM." };
  const deals = await activeDeals(ctx.makecrmConversationId);
  if (!deals.length) return { result: "O lead não tem oportunidade ativa: nada a mover. Siga a conversa." };
  const stageNames = new Map(
    (await rest<{ id: string; name: string }[]>(`pipeline_stages?select=id,name&id=in.(${[...new Set(deals.map((d) => d.stage_id))].join(",")})`)).map((s) => [s.id, s.name]),
  );
  let moved = 0;
  for (const d of deals) {
    if (d.stage_id === stage.id) continue;
    await rest(`pipeline_deals?id=eq.${d.id}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ pipeline_id: stage.pipeline_id, stage_id: stage.id, updated_at: new Date().toISOString() }),
    });
    await addStory(d.id, ctx.maviUserId, `A oportunidade foi movida de "${stageNames.get(d.stage_id) ?? "?"}" para "${stage.name}" pela MAVI${reason ? ` (${reason.slice(0, 200)})` : ""}.`).catch(() => {});
    await rest("pipeline_deal_stage_logs", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ deal_id: d.id, stage_id: stage.id, user_id: ctx.maviUserId }),
    }).catch(() => {});
    if (runAutomations && config().MAKECRM_AUTOMATIONS_URL)
      await fetch(config().MAKECRM_AUTOMATIONS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: ctx.maviUserId,
          company_id: ctx.companyId,
          pipeline_id: stage.pipeline_id,
          out_stage_id: d.stage_id,
          in_stage_id: stage.id,
          deal_id: d.id,
          contact_id: d.contact_id,
        }),
        signal: AbortSignal.timeout(10_000),
      }).catch((e) => log.warn({ err: String(e) }, "mover: automações do MakeCRM não responderam"));
    moved++;
  }
  return { result: moved ? "Feito. Siga a conversa sem comentar a mudança." : "Já estava nessa etapa." };
}

const ROLE_COL = { owner: "user_id", sdr: "sdr_id", closer: "closer_id" } as const;
const ROLE_LABEL = { owner: "Proprietário", sdr: "SDR", closer: "Closer" } as const;

async function changeOwner(cfg: ChangeOwnerConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const rule = cfg.rules.find((r) => r.id === String(args.regra ?? ""));
  if (!rule) return { result: "Regra desconhecida.", silent: true };
  if (!ctx.simulation && !ctx.makecrmConversationId) return { result: "Sem conversa no CRM.", silent: true };
  const deals = ctx.simulation ? [] : await activeDeals(ctx.makecrmConversationId!);
  if (!ctx.simulation && !deals.length) return { result: "O lead não tem oportunidade ativa: nada a trocar. Siga a conversa.", silent: true };

  const roles = (Object.keys(ROLE_COL) as (keyof typeof ROLE_COL)[]).filter((r) => rule[r]);
  const chosen: Partial<Record<keyof typeof ROLE_COL, string>> = {};
  for (const role of roles) {
    const t = rule[role] as RoleTargetT;
    chosen[role] =
      t.mode === "fixed" ? t.user_id! : ctx.simulation ? (await rotationOrder(ctx.agentId, `${rule.id}:${role}`, t.users))[0]?.user_id : (await pickUser(ctx.agentId, `${rule.id}:${role}`, t.users)) ?? undefined;
  }
  const names = await userNames([...Object.values(chosen), ...deals.flatMap((d) => [d.user_id, d.sdr_id, d.closer_id])]);
  if (ctx.simulation)
    return {
      result: `Simulação: ${roles.map((r) => `${ROLE_LABEL[r]} → ${names.get(chosen[r] ?? "") || "?"}`).join(", ")}. Siga a conversa sem comentar.`,
      silent: true,
    };

  const patch = Object.fromEntries(roles.filter((r) => chosen[r]).map((r) => [ROLE_COL[r], chosen[r]]));
  for (const d of deals) {
    await rest(`pipeline_deals?id=eq.${d.id}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    });
    for (const r of roles) {
      const before = d[ROLE_COL[r]];
      if (chosen[r] && before !== chosen[r])
        await addStory(d.id, ctx.maviUserId, `A informação "${ROLE_LABEL[r]}" foi alterada de "${names.get(before ?? "") || "—"}" para "${names.get(chosen[r]!) || "—"}" pela MAVI.`).catch(() => {});
    }
  }
  if (rule.sync_conversation || rule.turn_off_ai) {
    await rest(`inbox_conversations?id=eq.${encodeURIComponent(ctx.makecrmConversationId!)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ ...(rule.sync_conversation ? patch : {}), ...(rule.turn_off_ai ? { ia_actived: false } : {}) }),
    });
    if (ctx.inboxId)
      await addPrivateNote(
        ctx.makecrmConversationId!,
        ctx.inboxId,
        `A MAVI trocou ${roles.map((r) => `${ROLE_LABEL[r]} para ${names.get(chosen[r] ?? "") || "—"}`).join(", ")}${args.motivo ? ` (${String(args.motivo).slice(0, 200)})` : ""}.${rule.turn_off_ai ? " A MAVI saiu desta conversa." : ""}`,
      ).catch(() => {});
  }
  return { result: "Feito. Siga a conversa sem comentar a mudança.", silent: true, action: { type: "trocar_responsavel", rule: rule.id, chosen } };
}

// ---------------------------------------------------------------- aviso à equipe

async function notifyTeam(cfg: TeamNotifyConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const message = String(args.mensagem ?? "").trim().slice(0, 1500);
  if (!message) return { result: "Mensagem vazia.", silent: true };
  if (ctx.simulation) return { result: `Simulação: a equipe receberia: "${message}".`, silent: true };
  const dedup = `nt:${ctx.conversationId}:${message.slice(0, 80)}`;
  if (!(await redis().set(dedup, "1", "EX", 300, "NX"))) return { result: "Já avisado.", silent: true };
  return { ...(await sendTeamNotice(cfg, message, ctx)), silent: true };
}

/** O aviso pelo WhatsApp da caixa configurada (Uazapi). */
export async function sendTeamNotice(cfg: TeamNotifyConfig, message: string, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const [inbox] = await rest<{ settings_id: number | null }[]>(`inboxes?select=settings_id&id=eq.${cfg.inbox_id}`);
  const [settings] = inbox?.settings_id
    ? await rest<{ settings: { provider?: string; schema?: { base_url?: string; token?: string } } }[]>(`inbox_settings?select=settings&id=eq.${inbox.settings_id}`)
    : [];
  const schema = settings?.settings?.schema;
  if (!schema?.base_url || !schema.token) return { result: "A caixa do aviso não é de WhatsApp por QR Code (Uazapi). Avise a equipe para corrigir." };
  const phone = ctx.phone ? `${ctx.phone.slice(0, -4).replace(/\d/g, "•")}${ctx.phone.slice(-4)}` : "";
  const link = ctx.makecrmConversationId && ctx.inboxId ? `https://app.usemakecrm.com.br/conversations/${ctx.inboxId}?chatId=${ctx.makecrmConversationId}` : "";
  const text = `🤖 ${ctx.agentName}\n${message}\n\nContato: ${ctx.contactName ?? "—"}${phone ? ` (${phone})` : ""}${link ? `\n${link}` : ""}`;
  for (const number of cfg.phones) {
    await fetch(`${schema.base_url.replace(/\/+$/, "")}/send/text`, {
      method: "POST",
      headers: { "content-type": "application/json", token: schema.token },
      body: JSON.stringify({ number, text }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => log.warn({ err: String(e) }, "aviso: envio falhou"));
  }
  return { result: "Equipe avisada. Siga a conversa sem comentar." };
}
