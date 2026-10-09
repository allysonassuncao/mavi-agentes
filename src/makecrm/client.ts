import { config } from "../config.js";
import { log } from "../log.js";

/**
 * Integração com o MakeCRM pelos pontos que já existem (sem mudar código dele):
 * - sendMessage (edge function) para responder ao lead — mesmo formato do mavi-llm;
 * - PostgREST (chave secreta, só no servidor) para desligar a IA da conversa,
 *   deixar nota privada e apontar o webhook de IA da caixa para este motor.
 */

const base = () => config().MAKECRM_SUPABASE_URL.replace(/\/+$/, "");

function restHeaders(extra: Record<string, string> = {}) {
  const key = config().MAKECRM_SECRET_KEY;
  return { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...extra };
}

export async function rest<T>(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`${base()}/rest/v1/${path}`, {
    ...init,
    headers: restHeaders(init.headers),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MakeCRM ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export type OutgoingAttachment = { id: number; type: string; extension: string; url: string; mime: string };

/** Envia uma mensagem do agente na conversa (aparece como enviada pelo usuário MAVI, role 4). */
export async function sendMessage(input: {
  companyId: string;
  userId: string | null;
  conversationId: string;
  content: string;
  attachments?: OutgoingAttachment[];
}): Promise<void> {
  const c = config();
  const now = new Date().toISOString();
  const payload = input.attachments?.length
    ? {
        message_id: 0,
        conversation_id: input.conversationId,
        forward: false,
        user_id: input.userId ?? "",
        company_id: input.companyId,
        content: input.content,
        private: false,
        attachment_ids: input.attachments.map((a) => ({
          id: a.id,
          type: a.type,
          extension: a.extension,
          url: a.url,
          thumbnail: a.url,
          size: 0,
          created_at: now,
          mimetype: a.mime,
        })),
        reply_id: null,
        created_at: now,
      }
    : {
        company_id: input.companyId,
        user_id: input.userId ?? "",
        conversation_id: input.conversationId,
        content: input.content,
        private: false,
        mavi_in_makecrm: true,
      };

  if (c.MAKECRM_DRY_RUN) {
    log.info({ conversationId: input.conversationId, chars: input.content.length, attachments: input.attachments?.length ?? 0 }, "makecrm: envio simulado (DRY_RUN)");
    return;
  }
  const res = await fetch(`${base()}/functions/v1/sendMessage`, {
    method: "POST",
    headers: { authorization: `Bearer ${c.MAKECRM_PUBLISHABLE_KEY}`, apikey: c.MAKECRM_PUBLISHABLE_KEY, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`MakeCRM sendMessage ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Desliga a IA na conversa e deixa uma nota privada para a equipe (igual ao "Off MAVI" do Go). */
export async function handOffToHuman(input: { conversationId: string; inboxId: string; reason: string }): Promise<void> {
  if (config().MAKECRM_DRY_RUN) {
    log.info({ conversationId: input.conversationId }, "makecrm: transferência simulada (DRY_RUN)");
    return;
  }
  await rest(`inbox_conversations?id=eq.${encodeURIComponent(input.conversationId)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ ia_actived: false }),
  });
  await rest("inbox_messages", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      conversation_id: input.conversationId,
      message_type: "outcoming",
      content: `A MAVI passou o atendimento para a equipe.${input.reason ? ` Motivo: ${input.reason}` : ""}`,
      content_type: "text",
      private: true,
      inbox_id: input.inboxId,
    }),
  });
}

/** Empresa do MakeCRM pelo código do cliente (companys.make_id = código do cliente na Make Vendas). */
export async function companyByMakeId(makeId: number): Promise<{ id: string; make_id: number; status: boolean } | null> {
  const rows = await rest<{ id: string; make_id: number; status: boolean }[]>(
    `companys?select=id,make_id,status&make_id=eq.${makeId}&limit=1`,
  );
  return rows[0] ?? null;
}

export type MakecrmInbox = { id: string; name: string; type_id: number; status: boolean };

/** Caixas de WhatsApp (tipos 1 Uazapi e 2 Business API) de uma empresa. */
export async function listInboxes(companyId: string): Promise<MakecrmInbox[]> {
  return rest<MakecrmInbox[]>(
    `inboxes?select=id,name,type_id,status&company_id=eq.${encodeURIComponent(companyId)}&type_id=in.(1,2)&order=name.asc`,
  );
}

export async function getInbox(inboxId: string): Promise<(MakecrmInbox & { company_id: string }) | null> {
  const rows = await rest<(MakecrmInbox & { company_id: string })[]>(
    `inboxes?select=id,name,type_id,status,company_id&id=eq.${encodeURIComponent(inboxId)}&limit=1`,
  );
  return rows[0] ?? null;
}

export async function getInboxWebhook(inboxId: string): Promise<string | null> {
  const rows = await rest<{ webhook_url: string | null }[]>(
    `agent_inbox_webhooks?select=webhook_url&inbox_id=eq.${encodeURIComponent(inboxId)}&limit=1`,
  );
  return rows[0]?.webhook_url ?? null;
}

/**
 * Agente antigo do MakeCRM ligado à caixa e desligado faz o Go bloquear a IA
 * (agent_inbox_connections → agents.status = false). Avisamos ao ligar.
 */
export async function inboxBlockedByLegacyAgent(inboxId: string): Promise<boolean> {
  const rows = await rest<{ agent_id: string; agents: { status: boolean | null } | null }[]>(
    `agent_inbox_connections?select=agent_id,agents(status)&inbox_id=eq.${encodeURIComponent(inboxId)}`,
  );
  return rows.length > 0 && !rows.some((r) => r.agents?.status === true);
}

export async function setInboxWebhook(inboxId: string, url: string | null): Promise<void> {
  if (url) {
    await rest("agent_inbox_webhooks?on_conflict=inbox_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ inbox_id: inboxId, webhook_url: url }]),
    });
  } else {
    await rest(`agent_inbox_webhooks?inbox_id=eq.${encodeURIComponent(inboxId)}`, {
      method: "DELETE",
      headers: { prefer: "return=minimal" },
    });
  }
}

// ---------------------------------------------------------------- modelos aprovados (WhatsApp Business API)

export type WabaTemplate = { template_id: string; name: string; category: string | null; content: Record<string, any> };

export async function listTemplates(companyId: string): Promise<WabaTemplate[]> {
  return rest<WabaTemplate[]>(
    `inbox_whatsapp_business_templates?select=template_id,name,category,content&company_id=eq.${encodeURIComponent(companyId)}&order=name.asc`,
  );
}

/** O texto do corpo do modelo e quantas variáveis ele tem (com os exemplos). */
export function templateBody(content: Record<string, any>): { text: string; examples: string[]; language: string; name: string } {
  const tc = (content?.template_config ?? content ?? {}) as Record<string, any>;
  const comps: any[] = Array.isArray(tc.components) ? tc.components : [];
  const body = comps.find((c) => String(c?.type ?? "").toUpperCase() === "BODY") ?? comps[0] ?? {};
  const text: string = tc.text || body.text || "";
  const ex = body.example ?? {};
  const examples: string[] = Array.isArray(ex.body_text_named_params)
    ? ex.body_text_named_params.map((p: any) => String(p?.example ?? ""))
    : Array.isArray(ex.body_text)
      ? (Array.isArray(ex.body_text[0]) ? ex.body_text[0] : ex.body_text).map((p: any) => String(p))
      : [];
  return { text, examples, language: tc.language || "pt_BR", name: tc.name || tc.template_name || "" };
}

/**
 * Envia um modelo aprovado pela conversa (como o serviço de follow-up do
 * MakeCRM faz): grava a mensagem no MakeCRM e pede o envio ao serviço de
 * mensagens, com as variáveis do corpo preenchidas.
 */
export async function sendTemplate(input: {
  companyId: string;
  conversationId: string;
  inboxId: string;
  maviUserId: string | null;
  template: WabaTemplate;
  params: string[];
}): Promise<void> {
  const c = config();
  const [conv] = await rest<{ identifier: string | null }[]>(`inbox_conversations?select=identifier&id=eq.${encodeURIComponent(input.conversationId)}`);
  const [inbox] = await rest<{ settings_id: number | null }[]>(`inboxes?select=settings_id&id=eq.${encodeURIComponent(input.inboxId)}`);
  const [settings] = inbox?.settings_id ? await rest<{ settings: { provider?: string; schema?: unknown } }[]>(`inbox_settings?select=settings&id=eq.${inbox.settings_id}`) : [];
  const [user] = input.maviUserId ? await rest<{ name: string | null }[]>(`users?select=name&id=eq.${input.maviUserId}`) : [];
  if (!conv?.identifier || !settings) throw new Error("Conversa ou caixa sem os dados do WhatsApp oficial.");
  const { text, language, name } = templateBody(input.template.content);
  const tc = (input.template.content?.template_config ?? {}) as Record<string, any>;
  const comps: any[] = Array.isArray(tc.components) ? tc.components : [];
  let i = 0;
  const components = comps
    .map((cp) => {
      const type = String(cp?.type ?? "").toLowerCase();
      if (type !== "body") return null;
      const count = (String(cp.text ?? text).match(/\{\{[^}]+\}\}/g) ?? []).length;
      return { type: "body", parameters: Array.from({ length: count }, () => ({ type: "text", text: input.params[i++] ?? "" })) };
    })
    .filter(Boolean);
  let rendered = text;
  let k = 0;
  rendered = rendered.replace(/\{\{[^}]+\}\}/g, () => input.params[k++] ?? "");
  const provider = settings.settings.provider || "whatsapp_business_api";
  const contentTemplate = {
    to: conv.identifier,
    type: "template",
    template: { name, language: { code: language }, components },
    recipient_type: "individual",
    template_config: { ...tc, text: rendered, type: "template", language, template_id: input.template.template_id, template_name: name },
    messaging_product: "whatsapp",
  };
  if (c.MAKECRM_DRY_RUN) {
    log.info({ conversationId: input.conversationId, template: name }, "makecrm: modelo simulado (DRY_RUN)");
    return;
  }
  const [msg] = await rest<{ id: number }[]>("inbox_messages", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      conversation_id: input.conversationId,
      message_type: "outcoming",
      content: rendered,
      content_type: "text",
      private: false,
      inbox_id: input.inboxId,
      content_template: contentTemplate,
      user_id: input.maviUserId,
    }),
  });
  await rest("inbox_messages_status", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ user_id: input.maviUserId, conversation_id: input.conversationId, message_id: msg!.id, status: "sent" }),
  }).catch(() => {});
  const res = await fetch(c.MAKECRM_TEMPLATE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider,
      database: {
        conversation_id: input.conversationId,
        conversation_identifier: conv.identifier,
        inbox_id: input.inboxId,
        inbox_company_id: input.companyId,
        user_id: input.maviUserId,
        user_name: user?.name ?? "MAVI",
        inbox_settings: { provider, schema: settings.settings.schema },
      },
      payload: {
        company_id: input.companyId,
        user_id: input.maviUserId,
        conversation_id: input.conversationId,
        message_id: msg!.id,
        content: rendered,
        template_name: name,
        template_language: language,
        template_components: components,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Envio do modelo falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/** A janela de 24h da caixa oficial está aberta para esta conversa? */
export async function wabaWindowOpen(conversationId: string): Promise<boolean> {
  const [conv] = await rest<{ window_id: string | null; last_inbound_at: string | null }[]>(
    `inbox_conversations?select=window_id,last_inbound_at&id=eq.${encodeURIComponent(conversationId)}`,
  );
  if (conv?.window_id) {
    const [w] = await rest<{ end_window: string | null }[]>(`inbox_whatsapp_business_template_windows?select=end_window&window_id=eq.${conv.window_id}`);
    if (w?.end_window) return Date.parse(w.end_window) > Date.now() + 60_000;
  }
  return !!conv?.last_inbound_at && Date.parse(conv.last_inbound_at) > Date.now() - 23.5 * 3600_000;
}

export async function conversationAiOn(conversationId: string): Promise<boolean> {
  const [c] = await rest<{ ia_actived: boolean | null }[]>(`inbox_conversations?select=ia_actived&id=eq.${encodeURIComponent(conversationId)}`);
  return c?.ia_actived !== false;
}

export async function inboxType(inboxId: string): Promise<number | null> {
  const [i] = await rest<{ type_id: number }[]>(`inboxes?select=type_id&id=eq.${encodeURIComponent(inboxId)}`);
  return i?.type_id ?? null;
}
