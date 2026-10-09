import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { log } from "../log.js";
import { rest } from "../makecrm/client.js";
import type { GoogleCalendarConfig } from "../spec/integrations.js";
import { addDays, hmToMin, spDate, spDayKey, spMinutes, spYmd } from "./time.js";

/**
 * Google Agenda pelas contas que os usuários conectaram no MakeCRM
 * (meet_google_tokens, uma por usuário). O motor lê a agenda (freeBusy),
 * calcula os horários livres e cria/remarca/cancela o evento com link do Meet.
 * O acesso vencido é renovado com o mesmo aplicativo Google do MakeCRM e
 * gravado de volta lá.
 */

/**
 * Por que a agenda falhou, para dizer como corrigir:
 * not_connected (ninguém conectou no MakeCRM), disconnected (acesso vencido
 * ou revogado: reconectar), wrong_app (o aplicativo Google do motor não é o
 * que conectou a agenda), no_app (o motor sem aplicativo Google),
 * no_permission (sem acesso à agenda), not_found (evento/agenda), error.
 */
export type CalendarErrorCode = "not_connected" | "disconnected" | "wrong_app" | "no_app" | "no_permission" | "not_found" | "error";

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly code: CalendarErrorCode = "error",
  ) {
    super(message);
  }
}

type Token = {
  id: number;
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  external_id: string | null;
  /** O aplicativo Google que conectou a agenda (id_data.aud do MakeCRM). */
  app: string | null;
};

/** A conta Google conectada do usuário (a mais recente). */
export async function googleToken(companyId: string, userId: string): Promise<Token | null> {
  const rows = await rest<(Omit<Token, "app"> & { id_data: { aud?: string; azp?: string } | null })[]>(
    `meet_google_tokens?select=id,user_id,access_token,refresh_token,external_id,id_data&company_id=eq.${encodeURIComponent(companyId)}&user_id=eq.${encodeURIComponent(userId)}&order=id.desc&limit=1`,
  );
  const r = rows[0];
  if (!r) return null;
  const { id_data, ...rest_ } = r;
  return { ...rest_, app: id_data?.azp ?? id_data?.aud ?? null };
}

/** O aplicativo do motor é outro que o que conectou a agenda (a renovação vai falhar). */
export function wrongApp(token: Pick<Token, "app">): boolean {
  const mine = config().GOOGLE_OAUTH_CLIENT_ID;
  return !!(mine && token.app && token.app !== mine);
}
const WRONG_APP =
  "O aplicativo Google do motor (GOOGLE_OAUTH_CLIENT_ID) não é o mesmo que conectou esta agenda no MakeCRM: use o mesmo cliente OAuth do MakeCRM no motor.";

/** Quem tem o Google conectado no MakeCRM (para o construtor). */
export async function connectedUsers(companyId: string): Promise<{ user_id: string; email: string | null }[]> {
  const rows = await rest<{ user_id: string; external_id: string | null }[]>(
    `meet_google_tokens?select=user_id,external_id&company_id=eq.${encodeURIComponent(companyId)}&refresh_token=not.is.null`,
  );
  const seen = new Map<string, string | null>();
  for (const r of rows) if (!seen.has(r.user_id)) seen.set(r.user_id, r.external_id);
  return [...seen.entries()].map(([user_id, email]) => ({ user_id, email }));
}

async function refresh(token: Token): Promise<string> {
  const c = config();
  if (!c.GOOGLE_OAUTH_CLIENT_ID || !c.GOOGLE_OAUTH_CLIENT_SECRET)
    throw new CalendarError("O acesso à agenda venceu e o motor não tem o aplicativo Google configurado (GOOGLE_OAUTH_CLIENT_ID/SECRET).", "no_app");
  if (wrongApp(token)) throw new CalendarError(WRONG_APP, "wrong_app");
  if (!token.refresh_token) throw new CalendarError("A agenda deste usuário precisa ser conectada de novo no MakeCRM.", "disconnected");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: c.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: c.GOOGLE_OAUTH_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !j.access_token) {
    if (j.error === "invalid_client" || j.error === "unauthorized_client") throw new CalendarError(WRONG_APP, "wrong_app");
    if (j.error === "invalid_grant")
      throw new CalendarError("A agenda deste usuário foi desconectada (acesso vencido ou revogado): conecte de novo no MakeCRM.", "disconnected");
    throw new CalendarError(`Não consegui renovar o acesso à agenda (${j.error ?? res.status}).`);
  }
  await rest(`meet_google_tokens?id=eq.${token.id}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ access_token: j.access_token }),
  }).catch((e) => log.warn({ err: String(e) }, "calendar: não gravou o token renovado no MakeCRM"));
  token.access_token = j.access_token;
  return j.access_token;
}

/** Chamada à API do Google com renovação automática (uma vez). */
async function gapi<T>(token: Token, path: string, init: RequestInit = {}): Promise<T> {
  const call = (access: string) =>
    fetch(`https://www.googleapis.com/calendar/v3${path}`, {
      ...init,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  let res = token.access_token ? await call(token.access_token) : null;
  if (!res || res.status === 401) res = await call(await refresh(token));
  if (res.status === 204) return {} as T;
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 404) throw new CalendarError("Evento ou agenda não encontrado no Google.", "not_found");
    if (res.status === 401) throw new CalendarError("A agenda deste usuário foi desconectada: conecte de novo no MakeCRM.", "disconnected");
    if (res.status === 403) throw new CalendarError("Sem permissão nesta agenda do Google (o usuário conectado não acessa a agenda escolhida).", "no_permission");
    throw new CalendarError(`O Google Agenda respondeu ${res.status}.`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const calendarOf = (t: Token) => t.external_id || "primary";

export type Busy = { start: number; end: number };

export async function busyTimes(token: Token, from: Date, to: Date): Promise<Busy[]> {
  const cal = calendarOf(token);
  const r = await gapi<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(token, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: "America/Sao_Paulo", items: [{ id: cal }] }),
  });
  const c = r.calendars?.[cal];
  if (c?.errors?.length) throw new CalendarError("Não consegui ler a agenda (sem permissão ou agenda inexistente).", "no_permission");
  return (c?.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

export type Slot = { start: Date; end: Date };

/**
 * Horários livres: dentro dos dias/horários permitidos, a partir da
 * antecedência mínima, em passos (ex.: de 30 em 30 min), sem cruzar eventos.
 */
export function freeSlots(cfg: Pick<GoogleCalendarConfig, "allowed_hours" | "duration_minutes" | "min_notice_minutes" | "slot_step_minutes">, busy: Busy[], fromYmd: string, days: number, now = new Date()): Slot[] {
  const out: Slot[] = [];
  const earliest = now.getTime() + cfg.min_notice_minutes * 60_000;
  const dur = cfg.duration_minutes * 60_000;
  for (let i = 0; i < days; i++) {
    const ymd = addDays(fromYmd, i);
    const win = cfg.allowed_hours[spDayKey(ymd) as keyof typeof cfg.allowed_hours];
    if (!win) continue;
    const winStart = spDate(ymd, win.from).getTime();
    const winEnd = win.to === "23:59" ? spDate(ymd, "23:59").getTime() + 60_000 : spDate(ymd, win.to).getTime();
    let t = Math.max(winStart, earliest);
    // Arredonda para o passo, contado da meia-noite local (10:07 → 10:30).
    const step = cfg.slot_step_minutes;
    const m = spMinutes(new Date(t));
    const extra = (step - (m % step)) % step;
    t = t - (new Date(t).getUTCSeconds() * 1000 + new Date(t).getUTCMilliseconds()) + extra * 60_000;
    for (; t + dur <= winEnd; t += step * 60_000) {
      if (t < earliest) continue;
      if (busy.some((b) => t < b.end && t + dur > b.start)) continue;
      out.push({ start: new Date(t), end: new Date(t + dur) });
    }
  }
  return out;
}

/** Escolhe poucos e espalhados: até `perDay` por dia, no período pedido. */
export function spreadSlots(slots: Slot[], limit: number, period: string | null, perDay = 3): Slot[] {
  const inPeriod = slots.filter((s) => {
    const m = spMinutes(s.start);
    if (period === "manha") return m < 12 * 60;
    if (period === "tarde") return m >= 12 * 60 && m < 18 * 60;
    if (period === "noite") return m >= 18 * 60;
    return true;
  });
  const byDay = new Map<string, Slot[]>();
  for (const s of inPeriod) {
    const d = spYmd(s.start);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const out: Slot[] = [];
  for (const list of byDay.values()) {
    // Espalha no dia: o primeiro, um do meio, o último.
    const pick = list.length <= perDay ? list : [list[0]!, list[Math.floor(list.length / 2)]!, list[list.length - 1]!].slice(0, perDay);
    for (const s of pick) {
      if (out.length >= limit) return out;
      out.push(s);
    }
  }
  return out;
}

export type CreatedEvent = { id: string; link: string | null; calendarId: string };

export async function createEvent(
  token: Token,
  input: { start: Date; end: Date; title: string; description: string; attendees: string[]; seeOthers: boolean; meet: boolean },
): Promise<CreatedEvent> {
  const cal = calendarOf(token);
  const ev = await gapi<{ id: string; hangoutLink?: string; htmlLink?: string }>(
    token,
    `/calendars/${encodeURIComponent(cal)}/events?conferenceDataVersion=${input.meet ? 1 : 0}&sendUpdates=${input.attendees.length ? "all" : "none"}`,
    {
      method: "POST",
      body: JSON.stringify({
        summary: input.title,
        description: input.description,
        start: { dateTime: input.start.toISOString(), timeZone: "America/Sao_Paulo" },
        end: { dateTime: input.end.toISOString(), timeZone: "America/Sao_Paulo" },
        ...(input.attendees.length ? { attendees: input.attendees.map((email) => ({ email })), guestsCanSeeOtherGuests: input.seeOthers } : {}),
        ...(input.meet ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
      }),
    },
  );
  return { id: ev.id, link: ev.hangoutLink ?? null, calendarId: cal };
}

type Attendee = { email: string; responseStatus?: string; [k: string]: unknown };

/**
 * Inclui e tira convidados de um evento sem mexer nos outros (quem a equipe
 * convidou direto no Google fica). O Google manda o convite aos novos e avisa
 * quem saiu.
 */
export async function changeAttendees(token: Token, eventId: string, change: { add: string[]; remove: string[]; seeOthers: boolean }) {
  const path = `/calendars/${encodeURIComponent(calendarOf(token))}/events/${encodeURIComponent(eventId)}`;
  const ev = await gapi<{ attendees?: Attendee[] }>(token, path);
  const removing = new Set(change.remove.map((e) => e.toLowerCase()));
  const kept = (ev.attendees ?? []).filter((a) => !removing.has(a.email.toLowerCase()));
  const have = new Set(kept.map((a) => a.email.toLowerCase()));
  const attendees = [...kept, ...change.add.filter((e) => !have.has(e.toLowerCase())).map((email) => ({ email }))];
  await gapi(token, `${path}?sendUpdates=all`, { method: "PATCH", body: JSON.stringify({ attendees, guestsCanSeeOtherGuests: change.seeOthers }) });
  return attendees.map((a) => a.email);
}

export async function moveEvent(token: Token, eventId: string, start: Date, end: Date, notify: boolean) {
  await gapi(token, `/calendars/${encodeURIComponent(calendarOf(token))}/events/${encodeURIComponent(eventId)}?sendUpdates=${notify ? "all" : "none"}`, {
    method: "PATCH",
    body: JSON.stringify({
      start: { dateTime: start.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: end.toISOString(), timeZone: "America/Sao_Paulo" },
    }),
  });
}

export async function cancelEvent(token: Token, eventId: string, notify: boolean) {
  await gapi(token, `/calendars/${encodeURIComponent(calendarOf(token))}/events/${encodeURIComponent(eventId)}?sendUpdates=${notify ? "all" : "none"}`, {
    method: "DELETE",
  }).catch((e) => {
    // Já apagado no Google: segue para atualizar o MakeCRM.
    if (!(e instanceof CalendarError && e.code === "not_found")) throw e;
  });
}

/** Horário pedido (ISO ou "AAAA-MM-DD HH:MM", em Brasília). */
export function parseWhen(v: string): Date | null {
  const s = v.trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s.slice(16))) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return spDate(m[1]!, `${m[2]}:${m[3]}`);
}

export const withinAllowed = (cfg: Pick<GoogleCalendarConfig, "allowed_hours">, start: Date, end: Date) => {
  const ymd = spYmd(start);
  const win = cfg.allowed_hours[spDayKey(ymd) as keyof typeof cfg.allowed_hours];
  if (!win || spYmd(end) !== ymd) return false;
  const a = spMinutes(start);
  const b = spMinutes(end) || 24 * 60;
  return a >= hmToMin(win.from) && b <= (win.to === "23:59" ? 24 * 60 : hmToMin(win.to));
};

export type CalendarCheck = {
  user_id: string;
  email: string | null;
  status: "ok" | CalendarErrorCode;
  message: string;
  /** Funciona agora, mas vai parar quando o acesso vencer (até 1 h): aplicativo trocado. */
  warning?: string;
};

/** Testa a agenda de um usuário: lê as próximas 24 h (renovando o acesso se preciso). */
export async function checkCalendar(companyId: string, userId: string): Promise<CalendarCheck> {
  const token = await googleToken(companyId, userId).catch(() => null);
  if (!token) return { user_id: userId, email: null, status: "not_connected", message: "Este usuário não conectou o Google Agenda no MakeCRM." };
  const base = { user_id: userId, email: token.external_id };
  try {
    const now = new Date();
    await busyTimes(token, now, new Date(now.getTime() + 86_400_000));
    return {
      ...base,
      status: "ok",
      message: "Agenda conectada e lida agora.",
      ...(wrongApp(token) ? { warning: WRONG_APP } : {}),
    };
  } catch (e) {
    if (e instanceof CalendarError) return { ...base, status: e.code, message: e.message };
    return { ...base, status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
