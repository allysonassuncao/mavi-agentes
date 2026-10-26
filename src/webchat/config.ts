import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Chat do site: um widget no site do cliente que é uma caixa do MakeCRM
 * (tipo "webchat"). A configuração fica no MakeCRM, em
 * inbox_settings.settings.webchat — quem cria pelo MakeCRM ("Nova caixa") ou
 * pela MAVI (Agentes MAVI › Caixas) grava o mesmo formato.
 */

const text = (max: number) => z.string().trim().max(max);

/** Domínio sem protocolo nem caminho (ex.: loja.com.br; *.loja.com.br vale para os subdomínios). */
export const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, ""))
  .pipe(z.string().min(3).max(253).regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$|^localhost$/, "Domínio inválido (ex.: loja.com.br)."));

export const WebchatConfig = z
  .object({
    /** Chave pública do widget (vai no código do site). */
    key: z.string().regex(/^wc_[A-Za-z0-9]{20,40}$/),
    title: text(60).default("Fale com a gente"),
    subtitle: text(120).default("Respondemos em instantes"),
    /** Cor principal (botão, cabeçalho, balões do visitante). */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#56793a"),
    position: z.enum(["right", "left"]).default("right"),
    avatar_url: z.union([z.literal(""), z.string().url().max(1000)]).default(""),
    /** Texto ao lado da bolinha (vazio = só a bolinha). */
    launcher_text: text(40).default(""),
    welcome: text(500).default("Olá! 👋 Como posso ajudar?"),
    suggestions: z.array(text(80).min(1)).max(5).default([]),
    /** Como o visitante se identifica: formulário antes, o agente pede na conversa, ou ninguém pede. */
    identify: z.enum(["form", "agent", "none"]).default("agent"),
    /** No formulário: e-mail também (nome e WhatsApp sempre). */
    ask_email: z.boolean().default(false),
    /** Onde o widget pode aparecer (vazio = em qualquer site). */
    domains: z.array(Domain).max(20).default([]),
    /** "Continuar no WhatsApp": o número da empresa (com DDI) e a mensagem que o visitante manda. */
    whatsapp: z
      .object({ phone: z.string().regex(/^\d{12,15}$/, "WhatsApp com DDI e DDD, só números (ex.: 5511999998888)."), text: text(300).default("Olá! Vim do chat do site.") })
      .nullable()
      .default(null),
    /** Cria a oportunidade no MakeCRM quando o visitante deixa nome e WhatsApp. */
    deal: z.object({ pipeline_id: z.string().uuid(), stage_id: z.string().uuid() }).nullable().default(null),
  });
// Sem .strict(): o MakeCRM e o MAVI gravam o mesmo formato; um campo a mais não derruba o chat.

export type WebchatConfigT = z.infer<typeof WebchatConfig>;
export const newWebchatKey = () => `wc_${randomBytes(18).toString("base64url").replace(/[-_]/g, "x")}`;

/** O que o navegador do visitante pode ver (sem domínios, funil…). */
export function publicConfig(c: WebchatConfigT, extra: { agent: boolean }) {
  return {
    title: c.title,
    subtitle: c.subtitle,
    color: c.color,
    position: c.position,
    avatar_url: c.avatar_url,
    launcher_text: c.launcher_text,
    welcome: c.welcome,
    suggestions: c.suggestions,
    identify: c.identify,
    ask_email: c.ask_email,
    whatsapp: !!c.whatsapp,
    agent: extra.agent,
  };
}

/** O site (origem) pode mostrar o widget? Sem domínios configurados, qualquer um. */
export function domainAllowed(domains: string[], origin: string | null | undefined): boolean {
  if (!domains.length) return true;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => (d.startsWith("*.") ? host === d.slice(2) || host.endsWith(d.slice(1)) : host === d || host === `www.${d}` || d === `www.${host}`));
}

/** O frame-ancestors do CSP para a página do chat embutida. */
export function frameAncestors(domains: string[]): string {
  if (!domains.length) return "*";
  return domains.flatMap((d) => (d.startsWith("*.") ? [`https://${d}`, `http://${d}`] : [`https://${d}`, `https://www.${d}`, `http://${d}`])).join(" ");
}

/** Telefone do visitante: só números, com o 55 se vier só com DDD. */
export function normalizePhone(v: unknown): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits.length >= 12 && digits.length <= 15 ? digits : null;
}

export function normalizeEmail(v: unknown): string | null {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s) && s.length <= 200 ? s : null;
}

/** As UTMs da página (para a oportunidade no MakeCRM). */
export function utmOf(pageUrl: string | null): Record<string, string> {
  if (!pageUrl) return {};
  try {
    const u = new URL(pageUrl);
    const out: Record<string, string> = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"]) {
      const v = u.searchParams.get(k);
      if (v) out[k] = v.slice(0, 200);
    }
    return out;
  } catch {
    return {};
  }
}
