import { db } from "../db.js";
import type { ToolDef } from "../llm/client.js";
import type { ActionDebug } from "../integrations/debug.js";
import { webchatInbox, type WebchatInbox } from "./makecrm.js";
import { identify, sessionByConversation, whatsappLink, WebchatError, type Session } from "./service.js";

/**
 * O agente no Chat do site: sabe que está no site (não no WhatsApp), pede ou
 * não os dados de contato conforme a caixa, registra o contato (que vira
 * contato e oportunidade no MakeCRM) e manda o link do "Continuar no WhatsApp".
 */

export const SITE_TOOLS = new Set(["registrar_contato_do_site", "link_do_whatsapp"]);

export type SiteChannel = { inbox: WebchatInbox; session: Session | null; line: string; tools: ToolDef[] };

/** Na simulação ou no WhatsApp: null. */
export async function siteChannel(conv: { binding_id: string | null; external_id: string; simulation: boolean }): Promise<SiteChannel | null> {
  if (conv.simulation || !conv.binding_id) return null;
  const [b] = await db()<{ channel: string; inbox_id: string }[]>`select channel, inbox_id from public.bindings where id = ${conv.binding_id}`;
  if (b?.channel !== "webchat") return null;
  const inbox = await webchatInbox(b.inbox_id);
  if (!inbox?.config) return null;
  const session = await sessionByConversation(conv.external_id);
  const cfg = inbox.config;
  const known = [session?.contact_name && `nome ${session.contact_name}`, session?.phone && `WhatsApp ${session.phone}`, session?.email && `e-mail ${session.email}`].filter(Boolean);
  const ask =
    cfg.identify === "agent" && !session?.phone
      ? "Peça o nome e o WhatsApp do visitante de forma natural quando fizer sentido (antes de passar uma proposta, marcar algo ou se ele quiser ser chamado depois) e registre com registrar_contato_do_site."
      : cfg.identify === "none"
        ? "Não peça dados de contato, a menos que o visitante queira ser chamado depois (aí registre com registrar_contato_do_site)."
        : "";
  const line = [
    `Canal: chat do site${session?.page_url ? ` (o visitante está na página ${session.page_url})` : ""}, não é o WhatsApp. As mensagens aparecem num chat no site.`,
    known.length ? `O visitante já informou: ${known.join(", ")}.` : "",
    ask,
    cfg.whatsapp ? "Se o visitante preferir falar pelo WhatsApp, use link_do_whatsapp e mande o link." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const tools: ToolDef[] = [
    {
      type: "function",
      function: {
        name: "registrar_contato_do_site",
        description: "Registra o nome, o WhatsApp e/ou o e-mail que o visitante informou (vira contato no CRM). Ação interna: não comente.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string" },
            whatsapp: { type: "string", description: "Com DDD (ex.: 11 99999-8888)." },
            email: { type: "string" },
          },
        },
      },
    },
  ];
  if (cfg.whatsapp)
    tools.push({
      type: "function",
      function: {
        name: "link_do_whatsapp",
        description: "Gera o link para o visitante continuar a conversa no WhatsApp da empresa (o histórico vai junto para a equipe). Mande o link na resposta.",
        parameters: { type: "object", properties: {} },
      },
    });
  return { inbox, session, line, tools };
}

export async function runSiteTool(site: SiteChannel, name: string, args: Record<string, unknown>): Promise<{ result: string; debug: ActionDebug }> {
  if (!site.session) return { result: "Não achei a sessão do visitante.", debug: { outcome: "error", code: "error", summary: "Sessão do site não encontrada." } };
  try {
    if (name === "link_do_whatsapp") {
      const url = await whatsappLink(site.inbox, site.session);
      return { result: `Link: ${url}\nMande este link ao visitante.`, debug: { outcome: "ok", summary: "Gerou o link do WhatsApp." } };
    }
    const s = await identify(site.inbox, site.session, { name: args.nome, phone: args.whatsapp, email: args.email }, { requirePhone: false });
    site.session = s;
    return {
      result: "Contato registrado.",
      debug: { outcome: "ok", summary: `Registrou ${[s.contact_name, s.phone, s.email].filter(Boolean).join(", ")}` },
    };
  } catch (e) {
    const msg = e instanceof WebchatError ? e.message : "Não consegui registrar agora.";
    return { result: `${msg} Confirme o dado com o visitante.`, debug: { outcome: "error", code: "error", summary: e instanceof Error ? e.message : String(e) } };
  }
}
