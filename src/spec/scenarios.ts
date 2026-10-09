import { z } from "zod";
import { ActivityAssignee } from "./integrations.js";

/**
 * Cenários: situações fora do roteiro em que o agente faz algo combinado
 * ("quando o lead pedir X, faça Y"). Ex.: o lead pede para nunca mais ser
 * chamado → a MAVI sai da conversa, dá a oportunidade como perdida e deixa o
 * motivo registrado no MakeCRM. O agente reconhece pela descrição e aciona a
 * ferramenta acionar_cenario; o motor executa as ações.
 */

const uuid = z.string().uuid();

export const ScenarioActions = z
  .object({
    /** Desliga a IA nesta conversa no MakeCRM depois da resposta (a pessoa pode religar). */
    turn_off_ai: z.boolean().default(false),
    /** Para a régua de follow-up desta conversa. */
    stop_followup: z.boolean().default(true),
    /** Cancela as reuniões futuras da oportunidade (as marcadas pelo agente e pela equipe). */
    cancel_meetings: z.boolean().default(false),
    /** Dá a oportunidade como perdida com este motivo (null = não). */
    lost_reason_id: uuid.nullable().default(null),
    /** Ao dar como perdida, conclui as atividades em aberto (como na tela do MakeCRM). */
    complete_activities: z.boolean().default(true),
    /** Leva a oportunidade para esta etapa (null = não move). */
    stage: z.object({ pipeline_id: uuid, stage_id: uuid }).strict().nullable().default(null),
    /** Cria uma atividade para a equipe (null = não). */
    activity: z
      .object({
        type_id: uuid,
        subject: z.string().trim().min(1).max(200),
        due_hours: z.number().int().min(0).max(720).default(24),
        assignee: ActivityAssignee.default({ mode: "deal_role", role: "owner", user_id: null, users: [] }),
      })
      .strict()
      .nullable()
      .default(null),
    /** Avisa a equipe pelo WhatsApp (precisa da integração "Avisar a equipe"). */
    notify_team: z.boolean().default(false),
  })
  .strict();

export const Scenario = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    /** Como reconhecer (ex.: "O lead pede para não receber mais mensagens"). */
    when: z.string().trim().min(3).max(1000),
    /** agent: o agente responde à vontade; fixed: manda a mensagem abaixo; none: não responde. */
    reply: z.enum(["agent", "fixed", "none"]).default("agent"),
    message: z.string().trim().max(1000).default(""),
    actions: ScenarioActions.default(ScenarioActions.parse({})),
  })
  .strict()
  .refine((s) => s.reply !== "fixed" || !!s.message, { message: "Escreva a mensagem que o agente envia.", path: ["message"] });

export const Scenarios = z
  .array(Scenario)
  .max(30)
  .default([])
  .refine((list) => new Set(list.map((s) => s.id)).size === list.length, "Dois cenários com o mesmo código.");

export type ScenarioT = z.infer<typeof Scenario>;
export type ScenarioActionsT = z.infer<typeof ScenarioActions>;
