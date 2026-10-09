/**
 * O diagnóstico de cada ação do agente (Registro técnico): o que deu, por quê
 * e o que ajustar. Fica no rastro da resposta (turns.tools[].debug).
 *
 * outcome: ok (fez), empty (não havia o que fazer: sem horário, sem
 * oportunidade…), blocked (segurado pela configuração de repetição), error
 * (falhou), simulated (aba Testar). code: o motivo, para agrupar os alertas.
 */
export type ActionDebug = {
  outcome: "ok" | "empty" | "blocked" | "error" | "simulated";
  code?: string;
  summary: string;
  details?: string[];
  hint?: string;
};

/** Os motivos que viram alerta quando se repetem (com o que ajustar). */
export const ACTIONABLE_CODES = new Set([
  "calendar_full",
  "calendar_limit",
  "calendar_no_hours",
  "calendar_period",
  "no_deal",
  "not_connected",
  "disconnected",
  "wrong_app",
  "no_app",
  "no_permission",
  "reminder_no_template",
  "reminder_failed",
  "error",
]);

/** Como corrigir as falhas da agenda (os códigos de CalendarError). */
export const CALENDAR_FIX: Record<string, string> = {
  wrong_app: "No motor (Portainer), GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET precisam ser os do aplicativo Google que o MakeCRM usa.",
  disconnected: "A pessoa precisa conectar o Google Agenda de novo no MakeCRM (Configurações › Google Agenda).",
  not_connected: "Conecte o Google Agenda dessa pessoa no MakeCRM ou escolha outro anfitrião.",
  no_app: "Configure GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET no motor (Portainer).",
  no_permission: "A conta Google conectada não acessa essa agenda: reconecte com a conta certa no MakeCRM.",
  not_found: "O evento ou a agenda não existe mais no Google.",
};
