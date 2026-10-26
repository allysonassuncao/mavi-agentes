import { randomBytes } from "node:crypto";
import { sha256 } from "../crypto.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { redis } from "../redis.js";
import type { Inbound } from "../runtime/inbound.js";
import { typingKey } from "../runtime/deliver.js";
import { receiveMessage } from "../runtime/receive.js";
import { normalizeEmail, normalizePhone, utmOf } from "./config.js";
import {
  attachmentUrls,
  conversationState,
  ensureConversation,
  insertMessage,
  lastMessages,
  maviUserId,
  messagesAfter,
  privateNote,
  upsertLead,
  userNames,
  type CrmMessage,
  type WebchatInbox,
} from "./makecrm.js";

/**
 * O visitante do Chat do site: a sessão (pela chave guardada no navegador
 * dele), as mensagens que ele manda (gravadas na caixa do MakeCRM e, com o
 * agente ligado e a IA ativa na conversa, respondidas pelo motor), as que ele
 * recebe (do agente ou da equipe) e o "Continuar no WhatsApp".
 */

export class WebchatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Session = {
  id: string;
  inbox_id: string;
  company_id: string;
  makecrm_conversation_id: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  page_url: string | null;
  utm: Record<string, string>;
  lead_synced_at: Date | null;
  wa_code: string | null;
};

export const VISITOR = /^[A-Za-z0-9_-]{24,80}$/;
const visitorHash = (visitor: string) => sha256(`webchat:${visitor}`);
const COLUMNS = ["id", "inbox_id", "company_id", "makecrm_conversation_id", "contact_name", "phone", "email", "page_url", "utm", "lead_synced_at", "wa_code"];
const cols = () => db()(COLUMNS);

export async function sessionFor(inbox: WebchatInbox, visitor: string): Promise<Session | null> {
  if (!VISITOR.test(visitor)) return null;
  const [s] = await db()<Session[]>`select ${cols()} from public.webchat_sessions where visitor_hash = ${visitorHash(visitor)}`;
  return s && s.inbox_id === inbox.id ? s : null;
}

/** Abre (ou retoma) a sessão do visitante. */
export async function openSession(inbox: WebchatInbox, visitor: string, meta: { pageUrl: string | null; referrer: string | null }): Promise<Session> {
  if (!VISITOR.test(visitor)) throw new WebchatError(400, "Visitante inválido.");
  const sql = db();
  const utm = utmOf(meta.pageUrl);
  const [s] = await sql<Session[]>`
    insert into public.webchat_sessions (inbox_id, company_id, visitor_hash, page_url, referrer, utm)
    values (${inbox.id}, ${inbox.company_id}, ${visitorHash(visitor)}, ${meta.pageUrl}, ${meta.referrer}, ${sql.json(utm as never)})
    on conflict (visitor_hash) do update set
      last_seen_at = now(),
      page_url = coalesce(excluded.page_url, public.webchat_sessions.page_url),
      -- As UTMs da primeira visita valem (a origem do lead).
      utm = case when public.webchat_sessions.utm = '{}'::jsonb then excluded.utm else public.webchat_sessions.utm end
    returning ${cols()}`;
  if (s!.inbox_id !== inbox.id) throw new WebchatError(409, "Sessão de outro chat.");
  return s!;
}

// ---------------------------------------------------------------- mensagens

export type WidgetMessage = { id: number; from: "visitor" | "agent" | "team"; name: string | null; text: string; at: string };

async function toWidget(rows: CrmMessage[], companyId: string): Promise<WidgetMessage[]> {
  const mavi = await maviUserId(companyId);
  const teamIds = [...new Set(rows.filter((m) => m.message_type === "outcoming" && m.user_id && m.user_id !== mavi).map((m) => m.user_id!))];
  const [names, files] = await Promise.all([userNames(teamIds), attachmentUrls(rows.filter((m) => m.attachment_id != null).map((m) => m.attachment_id!))]);
  return rows
    .map((m) => ({ m, text: [m.content ?? "", m.attachment_id != null ? (files.get(String(m.attachment_id)) ?? "") : ""].filter((x) => x.trim()).join("\n") }))
    .filter((x) => x.text.trim())
    .map(({ m, text }) => {
      const from = m.message_type === "incoming" ? "visitor" : !m.user_id || m.user_id === mavi ? "agent" : "team";
      return { id: Number(m.id), from, name: from === "team" ? (names.get(m.user_id!) ?? "Equipe") : null, text, at: m.created_at };
    });
}

export async function history(session: Session): Promise<WidgetMessage[]> {
  if (!session.makecrm_conversation_id) return [];
  return toWidget(await lastMessages(session.makecrm_conversation_id), session.company_id);
}

/** Espera mensagens novas (até `waitMs`), devolvendo também se o agente está escrevendo. */
export async function poll(session: Session, after: number, waitMs: number): Promise<{ messages: WidgetMessage[]; typing: boolean }> {
  const conv = session.makecrm_conversation_id;
  if (!conv) return { messages: [], typing: false };
  const until = Date.now() + Math.min(Math.max(waitMs, 0), 25_000);
  for (;;) {
    const rows = await messagesAfter(conv, after);
    const typing = !!(await redis().get(typingKey(conv)).catch(() => null));
    if (rows.length || Date.now() + 2500 > until) return { messages: await toWidget(rows, session.company_id), typing };
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function bindingOf(inboxId: string) {
  const [b] = await db()<{ id: string; agent_id: string; company_id: string }[]>`
    select id, agent_id, company_id from public.bindings
    where inbox_id = ${inboxId} and removed_at is null and enabled and channel = 'webchat'`;
  return b ?? null;
}

/** O visitante escreveu: grava na caixa do MakeCRM e, se o agente estiver ligado, agenda a resposta. */
export async function visitorSend(inbox: WebchatInbox, session: Session, text: string): Promise<{ message: WidgetMessage; typing: boolean }> {
  const content = text.trim().slice(0, 4000);
  if (!content) throw new WebchatError(400, "Mensagem vazia.");
  const conv = session.makecrm_conversation_id
    ? { id: session.makecrm_conversation_id }
    : await ensureConversation(inbox.id, `site:${session.id}`, session.contact_name || "Visitante do site");
  if (!session.makecrm_conversation_id) {
    session.makecrm_conversation_id = conv.id;
    await db()`update public.webchat_sessions set makecrm_conversation_id = ${conv.id}, last_seen_at = now() where id = ${session.id}`;
    // O formulário veio antes da primeira mensagem: o contato entra agora.
    if (session.phone || session.email) await syncLead(inbox, session).catch((e) => log.warn({ err: String(e) }, "webchat: contato não criado"));
    await privateNote(inbox.id, conv.id, siteNote(session)).catch(() => {});
  } else await db()`update public.webchat_sessions set last_seen_at = now() where id = ${session.id}`;

  const crm = await insertMessage({ inboxId: inbox.id, conversationId: conv.id, type: "incoming", content, sourceId: `wc:${randomBytes(8).toString("hex")}` });
  const binding = await bindingOf(inbox.id);
  let typing = false;
  if (binding) {
    const state = await conversationState(conv.id);
    if (state?.ia_actived !== false) {
      const msg: Inbound = {
        companyId: inbox.company_id,
        inboxId: inbox.id,
        conversationId: conv.id,
        phone: session.phone,
        name: session.contact_name,
        text: content,
        contentType: "text",
        mediaUrl: null,
        sourceId: `wc:${crm.id}`,
        fromMe: false,
        isCall: false,
        maviUserId: await maviUserId(inbox.company_id),
        referral: null,
      };
      const r = await receiveMessage(binding, msg);
      if (r === "ok") {
        typing = true;
        await redis().set(typingKey(conv.id), "1", "EX", 90).catch(() => {});
      }
    }
  }
  const [w] = await toWidget([crm], inbox.company_id);
  return { message: w!, typing };
}

function siteNote(s: Session): string {
  const parts = [`Conversa iniciada pelo chat do site${s.page_url ? ` (${s.page_url})` : ""}.`];
  const utm = Object.entries(s.utm ?? {}).map(([k, v]) => `${k}=${v}`);
  if (utm.length) parts.push(`Origem: ${utm.join(", ")}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------- identificação

export type IdentifyInput = { name?: unknown; phone?: unknown; email?: unknown };

/** Nome, WhatsApp e e-mail do visitante (formulário ou o agente pela conversa). */
export async function identify(inbox: WebchatInbox, session: Session, input: IdentifyInput, opts: { requirePhone: boolean }): Promise<Session> {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 120) || null : null;
  const phone = input.phone != null && input.phone !== "" ? normalizePhone(input.phone) : null;
  const email = input.email != null && input.email !== "" ? normalizeEmail(input.email) : null;
  if (input.phone != null && input.phone !== "" && !phone) throw new WebchatError(400, "WhatsApp inválido: use DDD e número.");
  if (input.email != null && input.email !== "" && !email) throw new WebchatError(400, "E-mail inválido.");
  if (opts.requirePhone && (!name || !phone)) throw new WebchatError(400, "Informe nome e WhatsApp.");
  const [s] = await db()<Session[]>`
    update public.webchat_sessions set
      contact_name = coalesce(${name}, contact_name), phone = coalesce(${phone}, phone), email = coalesce(${email}, email),
      lead_synced_at = null, last_seen_at = now()
    where id = ${session.id}
    returning ${cols()}`;
  const next = s!;
  if (next.makecrm_conversation_id) {
    await syncLead(inbox, next).catch((e) => log.warn({ err: String(e) }, "webchat: contato não atualizado"));
    // A conversa do motor também passa a saber quem é.
    await db()`
      update public.conversations set contact_name = coalesce(${next.contact_name}, contact_name), phone = coalesce(${next.phone}, phone),
        facts = facts || ${db().json((next.email ? { email: next.email } : {}) as never)}
      where external_id = ${next.makecrm_conversation_id} and not simulation`;
  }
  return next;
}

async function syncLead(inbox: WebchatInbox, s: Session) {
  if (!s.makecrm_conversation_id || (!s.phone && !s.email)) return;
  await upsertLead({
    companyId: inbox.company_id,
    conversationId: s.makecrm_conversation_id,
    name: s.contact_name,
    phone: s.phone,
    email: s.email,
    deal: inbox.config?.deal ?? null,
    utm: s.utm ?? {},
  });
  await db()`update public.webchat_sessions set lead_synced_at = now() where id = ${s.id}`;
}

// ---------------------------------------------------------------- WhatsApp

const CODE = /\bWEB-([A-Z0-9]{6})\b/i;

/** O link do "Continuar no WhatsApp" (com o código que liga as duas conversas). */
export async function whatsappLink(inbox: WebchatInbox, session: Session): Promise<string> {
  const wa = inbox.config?.whatsapp;
  if (!wa) throw new WebchatError(400, "Este chat não tem WhatsApp configurado.");
  let code = session.wa_code;
  if (!code) {
    code = `WEB-${randomBytes(6).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "7").slice(0, 6)}`;
    await db()`update public.webchat_sessions set wa_code = ${code} where id = ${session.id}`;
    if (session.makecrm_conversation_id)
      await privateNote(inbox.id, session.makecrm_conversation_id, `O visitante abriu o WhatsApp para continuar a conversa (código ${code}).`).catch(() => {});
  }
  return `https://wa.me/${wa.phone}?text=${encodeURIComponent(`${wa.text} (código ${code})`)}`;
}

/**
 * Chegou no WhatsApp uma mensagem com o código do site: a equipe recebe uma
 * nota com a conversa do site e o agente passa a saber o que já foi dito.
 */
export async function linkSiteHandoff(msg: Inbound): Promise<void> {
  const m = msg.text.match(CODE);
  if (!m) return;
  const code = `WEB-${m[1]!.toUpperCase()}`;
  const [s] = await db()<(Session & { wa_used_at: Date | null })[]>`
    update public.webchat_sessions set wa_used_at = coalesce(wa_used_at, now())
    where wa_code = ${code} and company_id = ${msg.companyId}
    returning ${cols()}, wa_used_at`;
  if (!s?.makecrm_conversation_id) return;
  const rows = await lastMessages(s.makecrm_conversation_id, 30);
  const transcript = rows
    .filter((r) => (r.content ?? "").trim())
    .map((r) => `${r.message_type === "incoming" ? "Visitante" : "Empresa"}: ${(r.content ?? "").slice(0, 400)}`)
    .join("\n")
    .slice(-3000);
  await privateNote(msg.inboxId, msg.conversationId, `Veio do chat do site (código ${code}). Conversa no site:\n${transcript}`);
  await db()`
    update public.conversations set summary = case when summary = '' then ${`Antes, no chat do site:\n${transcript}`.slice(0, 4000)} else summary end,
      facts = facts || ${db().json({ veio_do_chat_do_site: "sim", ...(s.contact_name ? { nome: s.contact_name } : {}), ...(s.email ? { email: s.email } : {}) } as never)}
    where external_id = ${msg.conversationId} and not simulation`;
}

/** A sessão do site de uma conversa do MakeCRM (para as ferramentas do agente). */
export async function sessionByConversation(conversationId: string): Promise<Session | null> {
  const [s] = await db()<Session[]>`select ${cols()} from public.webchat_sessions where makecrm_conversation_id = ${conversationId}`;
  return s ?? null;
}
