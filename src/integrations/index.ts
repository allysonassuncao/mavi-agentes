import { config } from "../config.js";
import { db } from "../db.js";
import type { ToolDef } from "../llm/client.js";
import { log } from "../log.js";
import { rest } from "../makecrm/client.js";
import { redis } from "../redis.js";
import type { AgentSpec } from "../spec/agent.js";
import type { ChangeOwnerConfig, DealActionsConfig, GoogleCalendarConfig, Integration, MoveDealConfig, RoleTargetT, TeamNotifyConfig } from "../spec/integrations.js";
import {
  busyTimes,
  CalendarError,
  cancelEvent,
  changeAttendees,
  createEvent,
  freeSlots,
  googleToken,
  moveEvent,
  parseWhen,
  spreadSlots,
  withinAllowed,
} from "./calendar.js";
import { activeDeals, addPrivateNote, addStory, userNames, type Deal } from "./deals.js";
import { activityAssignee, addNote, catalogProduct, conversationDeals, createActivity, createQuote, mainDeal, markLost, markWon } from "./deal-actions.js";
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
          ...(cal.max_guests > 0
            ? { convidados: { type: "array", items: { type: "string" }, description: `E-mails de outras pessoas que o lead pediu para convidar (até ${cal.max_guests}).` } }
            : {}),
          observacao: { type: "string", description: "Assunto ou observação curta para a descrição (opcional)." },
        },
        ["horario"],
      ),
      fn("agenda_remarcar", "Remarca a reunião já marcada com este lead para outro horário livre.", { horario: { type: "string", description: "Código (H#) ou AAAA-MM-DD HH:MM." } }, ["horario"]),
      fn("agenda_cancelar", "Cancela a reunião marcada com este lead.", { motivo: { type: "string" } }),
    );
    if (cal.max_guests > 0)
      tools.push(
        fn(
          "agenda_convidar",
          `Inclui outras pessoas (sócio, colega…) no convite da reunião já marcada com este lead, quando ele pedir. Até ${cal.max_guests} além do lead. Peça o e-mail de cada uma; se parecer ter erro de digitação, confirme antes.`,
          { emails: { type: "array", items: { type: "string" }, description: "E-mails a convidar." } },
          ["emails"],
        ),
        fn(
          "agenda_remover_convidado",
          "Tira do convite pessoas que o lead incluiu nesta conversa, quando ele pedir.",
          { emails: { type: "array", items: { type: "string" }, description: "E-mails a tirar." } },
          ["emails"],
        ),
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
  const da = get(spec, "makecrm_deal_actions");
  if (da) tools.push(...dealActionTools(da));
  return tools;
}

const guideOf = (when: string) => (when.trim() ? ` Quando: ${when.trim()}.` : "");
/** Códigos curtos para o modelo (R1 motivo, P1 produto, T1 tipo de atividade). */
const code = (prefix: string, i: number) => `${prefix}${i + 1}`;

function dealActionTools(da: DealActionsConfig): ToolDef[] {
  const out: ToolDef[] = [];
  if (da.lost.enabled)
    out.push(
      fn(
        "dar_como_perdido",
        `Dá a oportunidade do lead como PERDIDA no CRM, com o motivo.${guideOf(da.lost.when)} Só quando estiver claro na conversa; não use por uma objeção que ainda dá para contornar. Ação interna: não comente com o lead. Motivos:\n${da.lost.reasons.map((r, i) => `- ${code("R", i)}: ${r.name || r.id}`).join("\n")}`,
        {
          motivo: { type: "string", enum: da.lost.reasons.map((_, i) => code("R", i)) },
          observacao: { type: "string", description: "Em poucas palavras, o que o lead disse (fica no histórico)." },
        },
        ["motivo"],
      ),
    );
  if (da.won.enabled)
    out.push(
      fn(
        "dar_como_ganho",
        `Dá a oportunidade do lead como GANHA no CRM, pelos orçamentos registrados nela.${guideOf(da.won.when)} Só com a compra confirmada pelo lead${da.quote.enabled ? "; se ainda não houver orçamento, registre antes com registrar_orcamento" : ""}. Ação interna: não comente com o lead.`,
        { observacao: { type: "string", description: "Como o lead confirmou (fica no histórico)." } },
      ),
    );
  if (da.quote.enabled)
    out.push(
      fn(
        "registrar_orcamento",
        `Registra um orçamento na oportunidade do lead, com um produto do catálogo.${guideOf(da.quote.when)} O valor parte do preço do catálogo; só dá desconto até o limite de cada produto. Ação interna: não comente com o lead. Produtos:\n${da.quote.products
          .map((p, i) => `- ${code("P", i)}: ${p.name || p.product_id}${p.max_discount_pct > 0 ? ` (desconto máximo ${p.max_discount_pct}%)` : " (sem desconto)"}`)
          .join("\n")}`,
        {
          produto: { type: "string", enum: da.quote.products.map((_, i) => code("P", i)) },
          valor: { type: "number", description: "Valor combinado com o lead (opcional; padrão: o preço do catálogo)." },
          observacao: { type: "string", description: "Condições combinadas (parcelas, prazo…), opcional." },
        },
        ["produto"],
      ),
    );
  if (da.note.enabled)
    out.push(
      fn(
        "registrar_no_historico",
        `Registra uma observação no histórico da oportunidade do lead (informação útil para a equipe).${guideOf(da.note.when)} Ação interna: não comente com o lead.`,
        { texto: { type: "string", description: "A observação, curta e objetiva." } },
        ["texto"],
      ),
    );
  if (da.activity.enabled)
    out.push(
      fn(
        "criar_atividade",
        `Cria uma atividade para a equipe na oportunidade do lead (ex.: ligar, mandar e-mail).${guideOf(da.activity.when)} Ação interna: não comente com o lead. Tipos:\n${da.activity.types.map((t, i) => `- ${code("T", i)}: ${t.name || t.id}`).join("\n")}`,
        {
          tipo: { type: "string", enum: da.activity.types.map((_, i) => code("T", i)) },
          assunto: { type: "string", description: "O que a equipe precisa fazer, em poucas palavras." },
          descricao: { type: "string", description: "Detalhes (opcional)." },
          quando: { type: "string", description: "Data e hora AAAA-MM-DD HH:MM (Brasília) se o lead combinou um momento (opcional)." },
        },
        ["tipo", "assunto"],
      ),
    );
  return out;
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

export const INTEGRATION_TOOL_NAMES = new Set([
  "agenda_horarios_livres",
  "agenda_marcar",
  "agenda_remarcar",
  "agenda_cancelar",
  "agenda_convidar",
  "agenda_remover_convidado",
  "mover_oportunidade",
  "trocar_responsavel",
  "avisar_equipe",
  "dar_como_perdido",
  "dar_como_ganho",
  "registrar_orcamento",
  "registrar_no_historico",
  "criar_atividade",
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
      case "agenda_convidar":
        return await addGuests(need(get(ctx.spec, "google_calendar")), args, ctx);
      case "agenda_remover_convidado":
        return await removeGuests(need(get(ctx.spec, "google_calendar")), args, ctx);
      case "mover_oportunidade":
        return await moveDeal(need(get(ctx.spec, "makecrm_move_deal")), args, ctx);
      case "trocar_responsavel":
        return await changeOwner(need(get(ctx.spec, "makecrm_change_owner")), args, ctx);
      case "avisar_equipe":
        return await notifyTeam(need(get(ctx.spec, "team_notify")), args, ctx);
      case "dar_como_perdido":
        return await lostTool(need(get(ctx.spec, "makecrm_deal_actions")), args, ctx);
      case "dar_como_ganho":
        return await wonTool(need(get(ctx.spec, "makecrm_deal_actions")), args, ctx);
      case "registrar_orcamento":
        return await quoteTool(need(get(ctx.spec, "makecrm_deal_actions")), args, ctx);
      case "registrar_no_historico":
        return await noteTool(need(get(ctx.spec, "makecrm_deal_actions")), args, ctx);
      case "criar_atividade":
        return await activityTool(need(get(ctx.spec, "makecrm_deal_actions")), args, ctx);
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
  agenda_convidar: "google_calendar",
  agenda_remover_convidado: "google_calendar",
  mover_oportunidade: "makecrm_move_deal",
  trocar_responsavel: "makecrm_change_owner",
  avisar_equipe: "team_notify",
  dar_como_perdido: "makecrm_deal_actions",
  dar_como_ganho: "makecrm_deal_actions",
  registrar_orcamento: "makecrm_deal_actions",
  registrar_no_historico: "makecrm_deal_actions",
  criar_atividade: "makecrm_deal_actions",
};
const INTEGRATION_LABEL: Record<string, string> = {
  google_calendar: "Google Agenda",
  makecrm_move_deal: "Mover oportunidade",
  makecrm_change_owner: "Trocar responsável",
  team_notify: "Avisar a equipe",
  makecrm_deal_actions: "Ações na oportunidade",
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function leadEmail(args: Record<string, unknown>, ctx: IntegrationCtx): string | null {
  const v = String(args.email ?? ctx.facts["e-mail"] ?? ctx.facts.email ?? "").trim().toLowerCase();
  return EMAIL.test(v) ? v : null;
}

/** Os e-mails pedidos (lista ou texto com vírgulas), válidos, minúsculos e sem repetir. */
export function emailList(v: unknown): { valid: string[]; invalid: string[] } {
  const raw = (Array.isArray(v) ? v : String(v ?? "").split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const valid = [...new Set(raw.filter((x) => EMAIL.test(x)))];
  return { valid, invalid: raw.filter((x) => !EMAIL.test(x)) };
}

/** Domínios com erro de digitação comum → o certo (o agente confirma antes de convidar). */
const TYPO_DOMAINS: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com", "gmail.con": "gmail.com", "gmail.co": "gmail.com",
  "gmail.com.br": "gmail.com", "gnail.com": "gmail.com", "hotmial.com": "hotmail.com", "hotmail.con": "hotmail.com", "hotmal.com": "hotmail.com",
  "outlok.com": "outlook.com", "outlook.con": "outlook.com", "yahoo.con": "yahoo.com", "yaho.com": "yahoo.com", "icloud.con": "icloud.com",
};
export function emailTypos(emails: string[]): string[] {
  return emails.flatMap((e) => {
    const domain = e.split("@")[1] ?? "";
    const fix = TYPO_DOMAINS[domain];
    return fix ? [`${e} (talvez ${e.split("@")[0]}@${fix})`] : [];
  });
}

/** Valida os convidados pedidos: formato, digitação, limite e sem o anfitrião. */
function checkGuests(cfg: GoogleCalendarConfig, asked: unknown, already: string[], exclude: (string | null)[]): { ok: string[] } | { result: string } {
  const { valid, invalid } = emailList(asked);
  if (invalid.length) return { result: `Estes e-mails não parecem válidos: ${invalid.join(", ")}. Peça ao lead para conferir.` };
  const typos = emailTypos(valid);
  if (typos.length) return { result: `Confirme com o lead antes de convidar, parece haver erro de digitação: ${typos.join("; ")}.` };
  const skip = new Set([...already, ...exclude.filter((x): x is string => !!x)].map((x) => x.toLowerCase()));
  const fresh = valid.filter((e) => !skip.has(e));
  if (already.length + fresh.length > cfg.max_guests)
    return { result: `Posso incluir até ${cfg.max_guests} pessoa(s) além do lead nesta reunião${already.length ? ` (já há ${already.length})` : ""}. Peça ao lead para escolher.` };
  return { ok: fresh };
}

async function schedule(cfg: GoogleCalendarConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const slot = await slotFor(cfg, String(args.horario ?? ""), ctx);
  if (typeof slot === "string") return { result: slot };
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const email = cfg.invite_lead ? leadEmail(args, ctx) : null;
  let guests: string[] = [];
  if (cfg.max_guests > 0 && args.convidados != null && (!Array.isArray(args.convidados) || args.convidados.length)) {
    const host = ctx.simulation ? null : await googleToken(ctx.companyId, slot.host).catch(() => null);
    const g = checkGuests(cfg, args.convidados, [], [email, host?.external_id ?? null]);
    if ("result" in g) return { result: g.result };
    guests = g.ok;
  }
  if (email) {
    const typo = emailTypos([email]);
    if (typo.length) return { result: `Confirme o e-mail com o lead antes de marcar, parece haver erro de digitação: ${typo.join("; ")}.` };
  }
  const attendees = [...(email ? [email] : []), ...guests];
  const lead = ctx.contactName || ctx.phone || "lead";
  const title = cfg.title.replaceAll("{lead}", lead).replaceAll("{agente}", ctx.agentName).slice(0, 200);
  if (ctx.simulation) {
    return { result: `Simulação: a reunião seria marcada para ${spLabel(start)}${attendees.length ? ` com convite para ${attendees.join(", ")}` : ""}. Confirme ao lead normalmente.`, action: { type: "agenda_marcar", start: slot.start, host: slot.host, simulation: true } };
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
  const ev = await createEvent(token, { start, end, title, description, attendees, seeOthers: cfg.guests_see_others, meet: cfg.meet_link });
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
        attendees,
        description,
        link: ev.link,
        status: true,
      }),
    }).catch((e) => log.warn({ err: String(e) }, "agenda: não registrou a reunião na oportunidade"));
    await addStory(d.id, ctx.maviUserId, `<strong>Reunião agendada pela MAVI</strong><br/>Data: ${spLabel(start)}${ev.link ? `<br/>Link: ${ev.link}` : ""}${attendees.length ? `<br/>Participantes: ${attendees.join(", ")}` : ""}`).catch(() => {});
  }
  if (!deals.length && ctx.makecrmConversationId && ctx.inboxId)
    await addPrivateNote(ctx.makecrmConversationId, ctx.inboxId, `A MAVI marcou uma reunião para ${spLabel(start)}${ev.link ? ` — ${ev.link}` : ""}.`).catch(() => {});
  await db()`
    insert into public.agent_meetings (agent_id, conversation_id, company_id, host_user_id, calendar_id, event_id, starts_at, ends_at, link, attendee_email, guests, deal_ids)
    values (${ctx.agentId}, ${ctx.conversationId}, ${ctx.companyId}, ${slot.host}, ${ev.calendarId}, ${ev.id}, ${slot.start}, ${slot.end}, ${ev.link}, ${email}, ${guests}, ${deals.map((d) => d.id)})`;
  if (guests.length) await rememberGuests(ctx, guests);
  return {
    result: `Reunião marcada para ${spLabel(start)}.${ev.link ? ` Link: ${ev.link}` : ""}${attendees.length ? ` Convite enviado para ${attendees.join(", ")}.` : ""} Confirme ao lead.`,
    action: { type: "agenda_marcar", start: slot.start, host: slot.host, event_id: ev.id },
  };
}

async function currentMeeting(ctx: IntegrationCtx) {
  const [m] = await db()<{ id: string; host_user_id: string; event_id: string; starts_at: Date; ends_at: Date; attendee_email: string | null; guests: string[]; deal_ids: string[] }[]>`
    select id, host_user_id, event_id, starts_at, ends_at, attendee_email, guests, deal_ids from public.agent_meetings
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
  await moveEvent(token, m!.event_id, new Date(slot.start), new Date(slot.end), !!m!.attendee_email || m!.guests.length > 0);
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

/** Guarda os convidados nos dados do contato (o agente lembra quem já foi convidado). */
async function rememberGuests(ctx: IntegrationCtx, guests: string[]) {
  const value = guests.join(", ");
  ctx.facts = { ...ctx.facts, convidados: value };
  await db()`update public.conversations set facts = facts || ${db().json({ convidados: value } as never)} where id = ${ctx.conversationId}`;
}

/** Atualiza a lista na oportunidade do MakeCRM e conta a mudança na linha do tempo. */
async function syncGuests(ctx: IntegrationCtx, m: { event_id: string; deal_ids: string[]; attendee_email: string | null }, guests: string[], story: string) {
  const attendees = [...(m.attendee_email ? [m.attendee_email] : []), ...guests];
  await rest(`pipeline_deal_meets?event_id=eq.${encodeURIComponent(m.event_id)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ attendees }),
  }).catch(() => {});
  for (const d of m.deal_ids) await addStory(d, ctx.maviUserId, story).catch(() => {});
  await rememberGuests(ctx, guests);
}

async function addGuests(cfg: GoogleCalendarConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  if (cfg.max_guests <= 0) return { result: "Esta agenda não permite incluir outros convidados. Diga que a equipe envia o convite." };
  const m = ctx.simulation ? null : await currentMeeting(ctx);
  if (!m && !ctx.simulation) return { result: "Não há reunião marcada por mim com este lead. Marque primeiro (agenda_marcar), com os convidados." };
  const host = m ? await googleToken(ctx.companyId, m.host_user_id) : null;
  const g = checkGuests(cfg, args.emails, m?.guests ?? [], [m?.attendee_email ?? null, host?.external_id ?? null]);
  if ("result" in g) return { result: g.result };
  if (!g.ok.length) return { result: "Essas pessoas já estão no convite. Confirme ao lead." };
  if (ctx.simulation) return { result: `Simulação: ${g.ok.join(", ")} seria(m) incluído(s) no convite. Confirme ao lead normalmente.` };
  if (!host) throw new CalendarError("A agenda do anfitrião não está conectada no MakeCRM (conecte o Google Agenda dele lá).", "not_connected");
  await changeAttendees(host, m!.event_id, { add: g.ok, remove: [], seeOthers: cfg.guests_see_others });
  const guests = [...m!.guests, ...g.ok];
  await db()`update public.agent_meetings set guests = ${guests}, updated_at = now() where id = ${m!.id}`;
  await syncGuests(ctx, m!, guests, `<strong>Convidados incluídos pela MAVI</strong><br/>${g.ok.join(", ")}`);
  return { result: `Convite enviado para ${g.ok.join(", ")} (reunião de ${spLabel(m!.starts_at)}). Confirme ao lead.` };
}

async function removeGuests(cfg: GoogleCalendarConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const m = ctx.simulation ? null : await currentMeeting(ctx);
  if (!m && !ctx.simulation) return { result: "Não há reunião marcada por mim com este lead." };
  const { valid } = emailList(args.emails);
  // Só sai quem entrou por esta conversa (nunca o anfitrião, o lead ou alguém que a equipe convidou).
  const mine = new Set((m?.guests ?? []).map((x) => x.toLowerCase()));
  const out = ctx.simulation ? valid : valid.filter((e) => mine.has(e));
  if (!out.length) return { result: "Só consigo tirar do convite quem o lead incluiu nesta conversa. Para outras pessoas, diga que a equipe ajusta." };
  if (ctx.simulation) return { result: `Simulação: ${out.join(", ")} sairia(m) do convite.` };
  const host = await googleToken(ctx.companyId, m!.host_user_id);
  if (!host) throw new CalendarError("A agenda do anfitrião não está conectada no MakeCRM (conecte o Google Agenda dele lá).", "not_connected");
  await changeAttendees(host, m!.event_id, { add: [], remove: out, seeOthers: cfg.guests_see_others });
  const guests = m!.guests.filter((x) => !out.includes(x.toLowerCase()));
  await db()`update public.agent_meetings set guests = ${guests}, updated_at = now() where id = ${m!.id}`;
  await syncGuests(ctx, m!, guests, `<strong>Convidados retirados pela MAVI</strong><br/>${out.join(", ")}`);
  return { result: `${out.join(", ")} saiu(saíram) do convite. Confirme ao lead.` };
}

async function cancel(_cfg: GoogleCalendarConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  if (ctx.simulation) return { result: "Simulação: a reunião seria cancelada." };
  const m = await currentMeeting(ctx);
  if (!m) return { result: "Não há reunião marcada por mim com este lead." };
  const token = await googleToken(ctx.companyId, m.host_user_id);
  if (token) await cancelEvent(token, m.event_id, !!m.attendee_email || m.guests.length > 0);
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

// ---------------------------------------------------------------- ações na oportunidade

const pick = <T>(list: T[], prefix: string, v: unknown): T | undefined => {
  const m = String(v ?? "").trim().toUpperCase().match(new RegExp(`^${prefix}(\\d+)$`));
  return m ? list[Number(m[1]) - 1] : undefined;
};
const NO_DEAL = { result: "O lead não tem oportunidade aberta no CRM: nada a fazer. Siga a conversa.", silent: true };
/** Uma vez por conversa e chave no intervalo (o lead pode repetir a mesma coisa). */
const once = async (ctx: IntegrationCtx, key: string, seconds: number) => !!(await redis().set(`da:${ctx.conversationId}:${key}`, "1", "EX", seconds, "NX"));

async function lostTool(cfg: DealActionsConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const reason = pick(cfg.lost.reasons, "R", args.motivo);
  if (!reason) return { result: "Motivo desconhecido.", silent: true };
  const obs = String(args.observacao ?? "").trim().slice(0, 500);
  if (ctx.simulation) return { result: `Simulação: a oportunidade seria dada como perdida (${reason.name}). Siga a conversa sem comentar.`, silent: true };
  if (!ctx.makecrmConversationId) return { result: "Sem conversa no CRM.", silent: true };
  const deals = (await conversationDeals(ctx.makecrmConversationId)).filter((d) => d.status === 1);
  if (!deals.length) return NO_DEAL;
  if (!(await once(ctx, "lost", 3600))) return { result: "Já feito.", silent: true };
  for (const d of deals) await markLost(ctx, d, reason.id, obs, { cancelMeetings: cfg.lost.cancel_meetings, completeActivities: cfg.lost.complete_activities });
  return { result: "Feito. Siga a conversa sem comentar.", silent: true, action: { type: "dar_como_perdido", reason: reason.id, deals: deals.map((d) => d.id) } };
}

async function wonTool(cfg: DealActionsConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const obs = String(args.observacao ?? "").trim().slice(0, 500);
  if (ctx.simulation) return { result: "Simulação: a oportunidade seria dada como ganha pelos orçamentos dela. Siga a conversa sem comentar.", silent: true };
  if (!ctx.makecrmConversationId) return { result: "Sem conversa no CRM.", silent: true };
  const deal = await mainDeal(ctx.makecrmConversationId);
  if (!deal) return NO_DEAL;
  if (!(await once(ctx, "won", 3600))) return { result: "Já feito.", silent: true };
  const r = await markWon(ctx, deal, obs);
  if (!r.ok) {
    await redis().del(`da:${ctx.conversationId}:won`);
    return {
      result: cfg.quote.enabled
        ? "A oportunidade não tem orçamento. Registre o orçamento com registrar_orcamento e depois dê como ganha."
        : "A oportunidade não tem orçamento; a equipe precisa registrar antes. Siga a conversa sem comentar.",
      silent: true,
    };
  }
  return { result: `Feito (${r.total}). Siga a conversa sem comentar.`, silent: true, action: { type: "dar_como_ganho", deal: deal.id } };
}

async function quoteTool(cfg: DealActionsConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const item = pick(cfg.quote.products, "P", args.produto);
  if (!item) return { result: "Produto desconhecido.", silent: true };
  const product = await catalogProduct(ctx.companyId, item.product_id);
  if (!product) return { result: "Este produto não está mais ativo no catálogo do CRM. Não registre o orçamento; siga a conversa.", silent: true };
  const asked = typeof args.valor === "number" ? args.valor : Number(String(args.valor ?? "").replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  const price = Number.isFinite(asked) && asked > 0 ? Math.round(asked * 100) / 100 : product.price;
  const min = Math.round(product.price * (1 - item.max_discount_pct / 100) * 100) / 100;
  if (price < min)
    return {
      result: `Valor abaixo do permitido: o mínimo para este produto é ${min.toFixed(2)} (desconto máximo de ${item.max_discount_pct}%). Não ofereça nem aceite menos que isso.`,
      silent: true,
    };
  const obs = String(args.observacao ?? "").trim().slice(0, 500);
  if (ctx.simulation) return { result: `Simulação: orçamento de "${product.name}" por ${price.toFixed(2)} seria registrado. Siga a conversa sem comentar.`, silent: true };
  if (!ctx.makecrmConversationId) return { result: "Sem conversa no CRM.", silent: true };
  const deal = await mainDeal(ctx.makecrmConversationId);
  if (!deal) return NO_DEAL;
  if (!(await once(ctx, `quote:${product.id}:${price}`, 900))) return { result: "Já registrado.", silent: true };
  const label = await createQuote(ctx, deal, product, price, obs);
  return { result: `Orçamento registrado (${label}). Siga a conversa sem comentar.`, silent: true, action: { type: "registrar_orcamento", deal: deal.id, product: product.id, price } };
}

async function noteTool(_cfg: DealActionsConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const text = String(args.texto ?? "").trim().slice(0, 2000);
  if (!text) return { result: "Texto vazio.", silent: true };
  if (ctx.simulation) return { result: `Simulação: ficaria no histórico: "${text}".`, silent: true };
  if (!ctx.makecrmConversationId) return { result: "Sem conversa no CRM.", silent: true };
  const deals = await conversationDeals(ctx.makecrmConversationId, { closed: true });
  const target = deals.filter((d) => d.status === 1);
  const ids = (target.length ? target : deals.slice(0, 1)).map((d) => d.id);
  if (!ids.length) return NO_DEAL;
  if (!(await once(ctx, `note:${text.slice(0, 80)}`, 600))) return { result: "Já registrado.", silent: true };
  await addNote(ctx, ids, "Observação da MAVI", text);
  return { result: "Registrado. Siga a conversa sem comentar.", silent: true };
}

async function activityTool(cfg: DealActionsConfig, args: Record<string, unknown>, ctx: IntegrationCtx): Promise<IntegrationResult> {
  const type = pick(cfg.activity.types, "T", args.tipo);
  if (!type) return { result: "Tipo desconhecido.", silent: true };
  const subject = String(args.assunto ?? "").trim().slice(0, 200);
  if (!subject) return { result: "Assunto vazio.", silent: true };
  const asked = typeof args.quando === "string" ? parseWhen(args.quando) : null;
  const doIn = asked && asked.getTime() > Date.now() - 3600_000 ? asked : new Date(Date.now() + cfg.activity.default_due_hours * 3600_000);
  const deal = ctx.simulation || !ctx.makecrmConversationId ? null : await mainDeal(ctx.makecrmConversationId);
  if (ctx.simulation) {
    const who = cfg.activity.assignee.mode === "fixed" || cfg.activity.assignee.mode === "round_robin" ? await activityAssignee(ctx, {} as Deal, cfg.activity.assignee, "activity", true) : null;
    const name = who ? (await userNames([who])).get(who) : "";
    return { result: `Simulação: atividade "${type.name}: ${subject}" para ${spLabel(doIn)}${name ? ` com ${name}` : " com o responsável da oportunidade"}. Siga a conversa sem comentar.`, silent: true };
  }
  if (!deal) return NO_DEAL;
  if (!(await once(ctx, `activity:${type.id}:${subject.slice(0, 60)}`, 1800))) return { result: "Já criada.", silent: true };
  const userId = await activityAssignee(ctx, deal, cfg.activity.assignee, "activity");
  await createActivity(ctx, deal, { typeId: type.id, subject, description: String(args.descricao ?? "").trim().slice(0, 2000), doIn, userId });
  return { result: "Atividade criada. Siga a conversa sem comentar.", silent: true, action: { type: "criar_atividade", deal: deal.id, user: userId } };
}
