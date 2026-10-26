import { config } from "../config.js";
import { log } from "../log.js";
import { rest } from "../makecrm/client.js";
import { WebchatConfig, type WebchatConfigT } from "./config.js";

/**
 * O Chat do site dentro do MakeCRM: a caixa (tipo "webchat"), as conversas e
 * as mensagens gravadas direto no banco (como o Go faz com o WhatsApp), para a
 * equipe ver e responder na Caixa de entrada. O MakeCRM não envia nada para
 * caixas deste tipo: o widget lê as respostas daqui.
 */

const enc = encodeURIComponent;

let typeCache: { id: number; at: number } | null = null;

/** O id do tipo "webchat" em inbox_types (criado pelo SQL do MakeCRM). */
export async function webchatTypeId(): Promise<number> {
  if (typeCache && Date.now() - typeCache.at < 3_600_000) return typeCache.id;
  const [row] = await rest<{ id: number }[]>("inbox_types?select=id&type=eq.webchat&limit=1");
  if (!row) throw new Error("O MakeCRM ainda não tem o tipo de caixa Chat do site (rode sql/webchat_inbox.sql no MakeCRM).");
  typeCache = { id: row.id, at: Date.now() };
  return row.id;
}

export type WebchatInbox = { id: string; name: string; company_id: string; status: boolean; settings_id: string; config: WebchatConfigT | null };

type InboxRow = { id: string; name: string; company_id: string; status: boolean; settings_id: string; type_id: number };
type SettingsRow = { id: string; settings: { webchat?: unknown } | null };

const parseConfig = (s: SettingsRow | undefined): WebchatConfigT | null => {
  const r = WebchatConfig.safeParse(s?.settings?.webchat);
  return r.success ? r.data : null;
};

const keyCache = new Map<string, { inbox: WebchatInbox | null; at: number }>();

/** A caixa pela chave pública do widget (60 s em memória). */
export async function inboxByKey(key: string): Promise<WebchatInbox | null> {
  const hit = keyCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.inbox;
  const [s] = await rest<SettingsRow[]>(`inbox_settings?select=id,settings&settings->webchat->>key=eq.${enc(key)}&limit=1`);
  let inbox: WebchatInbox | null = null;
  if (s) {
    const [i] = await rest<InboxRow[]>(`inboxes?select=id,name,company_id,status,settings_id,type_id&settings_id=eq.${enc(s.id)}&limit=1`);
    if (i && i.type_id === (await webchatTypeId())) inbox = { ...i, config: parseConfig(s) };
  }
  keyCache.set(key, { inbox, at: Date.now() });
  return inbox;
}

export const forgetWebchatKey = (key: string) => keyCache.delete(key);

export async function webchatInbox(inboxId: string): Promise<WebchatInbox | null> {
  const [i] = await rest<InboxRow[]>(`inboxes?select=id,name,company_id,status,settings_id,type_id&id=eq.${enc(inboxId)}&limit=1`);
  if (!i || i.type_id !== (await webchatTypeId())) return null;
  const [s] = await rest<SettingsRow[]>(`inbox_settings?select=id,settings&id=eq.${enc(i.settings_id)}&limit=1`);
  return { ...i, config: parseConfig(s) };
}

export async function listWebchatInboxes(companyId: string): Promise<WebchatInbox[]> {
  const type = await webchatTypeId();
  const rows = await rest<InboxRow[]>(
    `inboxes?select=id,name,company_id,status,settings_id,type_id&company_id=eq.${enc(companyId)}&type_id=eq.${type}&order=name.asc`,
  );
  if (!rows.length) return [];
  const settings = await rest<SettingsRow[]>(`inbox_settings?select=id,settings&id=in.(${rows.map((r) => enc(r.settings_id)).join(",")})`);
  const byId = new Map(settings.map((s) => [s.id, s]));
  return rows.map((r) => ({ ...r, config: parseConfig(byId.get(r.settings_id)) }));
}

/** Cria a caixa no MakeCRM (visível para todos da empresa, como o "Nova caixa" faz sem escolher pessoas). */
export async function createWebchatInbox(companyId: string, name: string, cfg: WebchatConfigT): Promise<WebchatInbox> {
  const type = await webchatTypeId();
  const [s] = await rest<{ id: string }[]>("inbox_settings?select=id", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ identifier: name, settings: { schema: {}, provider: "webchat", webchat: cfg } }),
  });
  const [i] = await rest<InboxRow[]>("inboxes?select=id,name,company_id,status,settings_id,type_id", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ name, settings_id: s!.id, type_id: type, company_id: companyId, status: true }),
  });
  return { ...i!, config: cfg };
}

export async function updateWebchatInbox(inbox: WebchatInbox, patch: { name?: string; config?: WebchatConfigT; status?: boolean }): Promise<void> {
  if (patch.config) {
    const [s] = await rest<SettingsRow[]>(`inbox_settings?select=id,settings&id=eq.${enc(inbox.settings_id)}&limit=1`);
    await rest(`inbox_settings?id=eq.${enc(inbox.settings_id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ settings: { ...(s?.settings ?? {}), provider: "webchat", webchat: patch.config }, ...(patch.name ? { identifier: patch.name } : {}) }),
    });
    if (inbox.config) forgetWebchatKey(inbox.config.key);
    forgetWebchatKey(patch.config.key);
  }
  if (patch.name !== undefined || patch.status !== undefined)
    await rest(`inboxes?id=eq.${enc(inbox.id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ ...(patch.name ? { name: patch.name } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}) }),
    });
}

// ---------------------------------------------------------------- conversas e mensagens

export type CrmConversation = { id: string; ia_actived: boolean | null; name: string | null };

/** A conversa do visitante na caixa (identificador "site:<sessão>"). */
export async function ensureConversation(inboxId: string, identifier: string, name: string): Promise<CrmConversation> {
  const [found] = await rest<CrmConversation[]>(
    `inbox_conversations?select=id,ia_actived,name&inbox_id=eq.${enc(inboxId)}&identifier=eq.${enc(identifier)}&limit=1`,
  );
  if (found) return found;
  const [created] = await rest<CrmConversation[]>("inbox_conversations?select=id,ia_actived,name", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({ inbox_id: inboxId, name, identifier, ia_actived: true }),
  });
  return created!;
}

export async function conversationState(conversationId: string): Promise<CrmConversation | null> {
  const [c] = await rest<CrmConversation[]>(`inbox_conversations?select=id,ia_actived,name&id=eq.${enc(conversationId)}&limit=1`);
  return c ?? null;
}

export type CrmMessage = {
  id: number;
  message_type: "incoming" | "outcoming";
  content: string | null;
  content_type: string | null;
  private: boolean | null;
  user_id: string | null;
  attachment_id?: number | string | null;
  created_at: string;
};

/** Os endereços dos anexos (a equipe manda arquivo pela Caixa de entrada). */
export async function attachmentUrls(ids: (number | string)[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await rest<{ id: number | string; url: string | null }[]>(`inbox_attachments?select=id,url&id=in.(${ids.map((i) => enc(String(i))).join(",")})`).catch(() => []);
  return new Map(rows.filter((r) => r.url).map((r) => [String(r.id), r.url!]));
}

/** Grava a mensagem na conversa e atualiza a prévia da lista (igual ao Go). */
export async function insertMessage(input: {
  inboxId: string;
  conversationId: string;
  type: "incoming" | "outcoming";
  content: string;
  userId?: string | null;
  sourceId?: string | null;
}): Promise<CrmMessage> {
  if (config().MAKECRM_DRY_RUN && input.type === "outcoming") log.info({ conversation: input.conversationId }, "webchat: resposta gravada (DRY_RUN não se aplica ao chat do site)");
  const [m] = await rest<(CrmMessage & { status: string; source_id: string | null; reply_id: string | null; sent_by_device: boolean | null })[]>(
    "inbox_messages?select=id,message_type,content,content_type,private,user_id,created_at,status,source_id,reply_id,sent_by_device",
    {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        conversation_id: input.conversationId,
        inbox_id: input.inboxId,
        message_type: input.type,
        content: input.content,
        content_type: "text",
        private: false,
        status: "sent",
        source_id: input.sourceId ?? null,
        sent_by_device: false,
        ...(input.userId ? { user_id: input.userId } : {}),
      }),
    },
  );
  const msg = m!;
  const last = {
    id: msg.id,
    status: "sent",
    content: input.content.slice(0, 500),
    private: false,
    user_id: input.userId ?? null,
    inbox_id: input.inboxId,
    reply_id: null,
    source_id: input.sourceId ?? null,
    created_at: msg.created_at,
    content_type: "text",
    message_type: input.type,
    attachment_id: null,
    sent_by_device: false,
    conversation_id: input.conversationId,
  };
  await rest(`inbox_conversations?id=eq.${enc(input.conversationId)}&inbox_id=eq.${enc(input.inboxId)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      last_message_content: last,
      ...(input.type === "incoming" ? { last_inbound_at: new Date().toISOString() } : { last_outbound_at: new Date().toISOString() }),
    }),
  }).catch((e) => log.warn({ err: String(e) }, "webchat: prévia da conversa não atualizada"));
  return msg;
}

/** As mensagens públicas da conversa depois de um id (o que o widget mostra). */
export async function messagesAfter(conversationId: string, afterId: number, limit = 50): Promise<CrmMessage[]> {
  return rest<CrmMessage[]>(
    `inbox_messages?select=id,message_type,content,content_type,private,user_id,attachment_id,created_at&conversation_id=eq.${enc(conversationId)}` +
      `&id=gt.${afterId}&or=(private.is.null,private.eq.false)&order=id.asc&limit=${limit}`,
  );
}

export async function lastMessages(conversationId: string, limit = 60): Promise<CrmMessage[]> {
  const rows = await rest<CrmMessage[]>(
    `inbox_messages?select=id,message_type,content,content_type,private,user_id,attachment_id,created_at&conversation_id=eq.${enc(conversationId)}` +
      `&or=(private.is.null,private.eq.false)&order=id.desc&limit=${limit}`,
  );
  return rows.reverse();
}

const maviUserCache = new Map<string, { id: string | null; at: number }>();

/** O usuário MAVI (papel 4) da empresa: as respostas do agente saem em nome dele (igual ao Go). */
export async function maviUserId(companyId: string): Promise<string | null> {
  const hit = maviUserCache.get(companyId);
  if (hit && Date.now() - hit.at < 600_000) return hit.id;
  const [u] = await rest<{ id: string }[]>(`users?select=id&role=eq.4&status=eq.true&company_id=eq.${enc(companyId)}&limit=1`).catch(() => []);
  maviUserCache.set(companyId, { id: u?.id ?? null, at: Date.now() });
  return u?.id ?? null;
}

/** Quem da equipe respondeu (nome para o balão do widget). */
export async function userNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await rest<{ id: string; name: string | null }[]>(`users?select=id,name&id=in.(${ids.map(enc).join(",")})`).catch(() => []);
  return new Map(rows.map((r) => [r.id, (r.name ?? "").split(/\s+/)[0] || "Equipe"]));
}

// ---------------------------------------------------------------- contato e oportunidade

/**
 * Liga o visitante a um contato do MakeCRM (acha pelo WhatsApp ou cria), põe o
 * nome na conversa e, se configurado e ainda não houver oportunidade aberta
 * dele, cria a oportunidade no funil escolhido com as UTMs da página.
 */
export async function upsertLead(input: {
  companyId: string;
  conversationId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  deal: { pipeline_id: string; stage_id: string } | null;
  utm: Record<string, string>;
}): Promise<{ contactId: string | null; dealId: string | null }> {
  if (!input.phone && !input.email) return { contactId: null, dealId: null };
  if (input.name)
    await rest(`inbox_conversations?id=eq.${enc(input.conversationId)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ name: input.name }),
    }).catch(() => {});

  // O contato: pelo WhatsApp (ou e-mail) na empresa; senão, um novo.
  const ids = [input.phone, input.email].filter(Boolean) as string[];
  const found = await rest<{ id: string; contact_id: string; identifier: string; contacts: { company_id: string } | null }[]>(
    `contact_identifiers?select=id,contact_id,identifier,contacts!inner(company_id)&identifier=in.(${ids.map((x) => `"${x}"`).map(enc).join(",")})&contacts.company_id=eq.${enc(input.companyId)}&limit=5`,
  ).catch(() => []);
  let contactId = found[0]?.contact_id ?? null;
  if (!contactId) {
    const [c] = await rest<{ id: string }[]>("contacts?select=id", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ company_id: input.companyId, name: input.name || input.phone || input.email }),
    });
    contactId = c!.id;
  }
  const have = new Set(found.filter((f) => f.contact_id === contactId).map((f) => f.identifier));
  const identifierIds: string[] = found.filter((f) => f.contact_id === contactId).map((f) => f.id);
  for (const [value, method] of [
    [input.phone, 1],
    [input.email, 2],
  ] as const) {
    if (!value || have.has(value)) continue;
    const [row] = await rest<{ id: string }[]>("contact_identifiers?select=id", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ contact_id: contactId, identifier: value, method_id: method, status: true }),
    }).catch(() => []);
    if (row) identifierIds.push(row.id);
  }
  if (identifierIds.length)
    await rest("contact_identifier_conversations?on_conflict=identifier_id,conversation_id", {
      method: "POST",
      headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(identifierIds.map((id) => ({ identifier_id: id, conversation_id: input.conversationId }))),
    }).catch((e) => log.warn({ err: String(e) }, "webchat: contato não ligado à conversa"));

  let dealId: string | null = null;
  if (input.deal) {
    const [open] = await rest<{ id: string }[]>(
      `pipeline_deals?select=id&contact_id=eq.${enc(contactId)}&pipeline_id=eq.${enc(input.deal.pipeline_id)}&status=eq.1&limit=1`,
    ).catch(() => []);
    dealId = open?.id ?? null;
    if (!dealId) {
      const [d] = await rest<{ id: string }[]>("pipeline_deals?select=id", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({
          pipeline_id: input.deal.pipeline_id,
          stage_id: input.deal.stage_id,
          name: input.name || input.phone || input.email,
          value: 0,
          status: 1,
          contact_id: contactId,
          company_id: input.companyId,
          utm: input.utm,
        }),
      });
      dealId = d!.id;
    }
    const [linked] = await rest<{ deal_id: string }[]>(
      `pipeline_deal_inbox_conversations?select=deal_id&deal_id=eq.${enc(dealId)}&conversation_id=eq.${enc(input.conversationId)}&limit=1`,
    ).catch(() => []);
    if (!linked)
      await rest("pipeline_deal_inbox_conversations", {
        method: "POST",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ deal_id: dealId, conversation_id: input.conversationId }),
      }).catch((e) => log.warn({ err: String(e) }, "webchat: oportunidade não ligada à conversa"));
  }
  return { contactId, dealId };
}

/** Nota privada na conversa (para a equipe). */
export async function privateNote(inboxId: string, conversationId: string, content: string): Promise<void> {
  await rest("inbox_messages", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ conversation_id: conversationId, inbox_id: inboxId, message_type: "outcoming", content, content_type: "text", private: true }),
  });
}
