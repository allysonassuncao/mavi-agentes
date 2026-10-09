import { z } from "zod";

/**
 * O que o Go do MakeCRM manda para o webhook de IA da caixa (montarPayloadMAVI
 * em makecrm-message-recived/main.go). Campos do provedor (token, ids do
 * WhatsApp) são ignorados de propósito: o motor nunca guarda o token.
 */
export const GoPayload = z
  .object({
    phone: z.unknown().optional(),
    name: z.unknown().optional(),
    content: z.unknown().optional(),
    content_type: z.unknown().optional(),
    from_me: z.unknown().optional(),
    source_id: z.unknown().optional(),
    reply_id: z.unknown().optional(),
    is_call: z.unknown().optional(),
    base64: z.unknown().optional(),
    company_id: z.unknown().optional(),
    inbox_id: z.unknown().optional(),
    conversation_id: z.unknown().optional(),
    mavi_user_id: z.unknown().optional(),
    referral: z.unknown().optional(),
  })
  .passthrough();

export type Inbound = {
  companyId: string;
  inboxId: string;
  conversationId: string;
  phone: string | null;
  name: string | null;
  text: string;
  contentType: string;
  mediaUrl: string | null;
  sourceId: string | null;
  fromMe: boolean;
  isCall: boolean;
  maviUserId: string | null;
  referral: Record<string, unknown> | null;
};

const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const b = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";

/** Tipos que o motor trata como mídia (o resto é texto). */
export const MEDIA_TYPES = new Set(["ptt", "audio", "image", "sticker", "video", "document"]);

export function normalizeInbound(raw: unknown): Inbound | { error: string } {
  const p = GoPayload.safeParse(raw);
  if (!p.success) return { error: "corpo inválido" };
  const d = p.data;
  const conversationId = s(d.conversation_id);
  const inboxId = s(d.inbox_id);
  const companyId = s(d.company_id);
  if (!conversationId || !inboxId || !companyId) return { error: "faltam conversation_id, inbox_id ou company_id" };
  const contentType = s(d.content_type).toLowerCase() || "text";
  const mediaUrl = MEDIA_TYPES.has(contentType) ? s(d.base64) || null : null;
  const referral = d.referral && typeof d.referral === "object" && !Array.isArray(d.referral) && Object.keys(d.referral).length
    ? (d.referral as Record<string, unknown>)
    : null;
  return {
    companyId,
    inboxId,
    conversationId,
    phone: s(d.phone) || null,
    name: s(d.name) || null,
    text: s(d.content),
    contentType,
    mediaUrl: mediaUrl && /^https?:\/\//i.test(mediaUrl) ? mediaUrl : null,
    sourceId: s(d.source_id) || null,
    fromMe: b(d.from_me),
    isCall: b(d.is_call),
    maviUserId: s(d.mavi_user_id) || null,
    referral,
  };
}
