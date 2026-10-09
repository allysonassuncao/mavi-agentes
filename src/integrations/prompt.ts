import type { AgentSpec } from "../spec/agent.js";

const on = (spec: AgentSpec, type: string) => spec.integrations.some((i) => i.enabled && i.type === type);

/** O que o prompt diz sobre as integrações ligadas. */
export function integrationsPrompt(spec: AgentSpec): string {
  const lines: string[] = [];
  if (on(spec, "google_calendar"))
    lines.push(
      "Agendamento: busque os horários com agenda_horarios_livres, ofereça 2 ou 3 opções em texto natural (nunca mostre os códigos H1, H2 ao lead) e só marque com agenda_marcar depois de o lead escolher. Confirme a data, a hora e envie o link quando houver. Para mudar ou desmarcar, use agenda_remarcar ou agenda_cancelar.",
    );
  if (on(spec, "google_calendar") && spec.meeting_reminders?.enabled && spec.meeting_reminders.steps.some((x) => x.confirm))
    lines.push(
      "Confirmação de presença: quando o lead responder ao pedido de confirmação da reunião, registre com registrar_confirmacao. Se ele não puder ir, ofereça remarcar.",
    );
  if (on(spec, "makecrm_move_deal") || on(spec, "makecrm_change_owner") || on(spec, "team_notify") || on(spec, "makecrm_deal_actions"))
    lines.push(
      "Mover a oportunidade, trocar o responsável, avisar a equipe e as ações na oportunidade (perdido, ganho, orçamento, histórico, atividade) são ações internas: faça quando a situação pedir e continue a conversa normalmente, sem comentar com o lead.",
    );
  return lines.length ? `# O que você pode fazer\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}


export const SCENARIO_TOOL = "acionar_cenario";

/** O que o prompt diz sobre os cenários combinados ligados. */
export function scenarioPrompt(spec: AgentSpec): string {
  const list = spec.scenarios.filter((s) => s.enabled);
  if (!list.length) return "";
  return `# Cenários combinados\nSe o lead se encaixar num destes cenários, acione-o com ${SCENARIO_TOOL} antes de responder e siga a orientação que voltar. Não acione por suposição: só quando estiver claro.\n${list
    .map((s) => `- ${s.name}: ${s.when}`)
    .join("\n")}`;
}
