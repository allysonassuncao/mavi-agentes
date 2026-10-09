import type { AgentSpec } from "../spec/agent.js";

const on = (spec: AgentSpec, type: string) => spec.integrations.some((i) => i.enabled && i.type === type);

/** O que o prompt diz sobre as integrações ligadas. */
export function integrationsPrompt(spec: AgentSpec): string {
  const lines: string[] = [];
  if (on(spec, "google_calendar"))
    lines.push(
      "Agendamento: busque os horários com agenda_horarios_livres, ofereça 2 ou 3 opções em texto natural (nunca mostre os códigos H1, H2 ao lead) e só marque com agenda_marcar depois de o lead escolher. Confirme a data, a hora e envie o link quando houver. Para mudar ou desmarcar, use agenda_remarcar ou agenda_cancelar.",
    );
  if (on(spec, "makecrm_move_deal") || on(spec, "makecrm_change_owner") || on(spec, "team_notify"))
    lines.push("Mover a oportunidade, trocar o responsável e avisar a equipe são ações internas: faça quando a situação pedir e continue a conversa normalmente, sem comentar com o lead.");
  return lines.length ? `# O que você pode fazer\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}

