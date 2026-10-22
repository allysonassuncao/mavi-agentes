import { z } from "zod";
import { FollowupTemplate } from "./followup.js";
import { ActivityAssignee } from "./integrations.js";
import { WeeklyHours } from "./weekly-hours.js";

/**
 * Retornos combinados: o lead pede para ser chamado depois ("me chama na
 * terça", "semana que vem", "depois das 18h") e o agente registra o dia e a
 * hora (agendar_retorno). Na hora, o agente retoma a conversa sozinho, a
 * equipe recebe a atividade, ou os dois. Enquanto há retorno marcado, a régua
 * de follow-up espera (configurável). A pessoa configura ações em 4 momentos:
 * ao registrar, na hora, sem resposta ao retorno e quando o lead adia de novo.
 */

const uuid = z.string().uuid();

/** As ações de cada momento (as mesmas dos Cenários, todas desligadas por padrão). */
export const CallbackActions = z
  .object({
    /** Desliga a IA nesta conversa no MakeCRM (a pessoa pode religar). */
    turn_off_ai: z.boolean().default(false),
    /** Para a régua de follow-up desta conversa. */
    stop_followup: z.boolean().default(false),
    /** Cancela as reuniões futuras da oportunidade. */
    cancel_meetings: z.boolean().default(false),
    /** Dá a oportunidade como perdida com este motivo (null = não). */
    lost_reason_id: uuid.nullable().default(null),
    /** Ao dar como perdida, conclui as atividades em aberto. */
    complete_activities: z.boolean().default(true),
    /** Leva a oportunidade para esta etapa (null = não move). */
    stage: z.object({ pipeline_id: uuid, stage_id: uuid }).strict().nullable().default(null),
    /**
     * Cria uma atividade para a equipe (null = não). O prazo conta da hora do
     * retorno (ou de agora, se ela já passou) mais due_hours.
     */
    activity: z
      .object({
        type_id: uuid,
        subject: z.string().trim().min(1).max(200),
        due_hours: z.number().int().min(0).max(720).default(0),
        assignee: ActivityAssignee.default({ mode: "deal_role", role: "owner", user_id: null, users: [] }),
      })
      .strict()
      .nullable()
      .default(null),
    /** Registra no histórico da oportunidade (o pedido do lead e a data). */
    note: z.boolean().default(false),
    /** Avisa a equipe pelo WhatsApp (precisa da integração "Avisar a equipe"). */
    notify_team: z.boolean().default(false),
  })
  .strict();

const NONE = CallbackActions.parse({});

export const Callbacks = z
  .object({
    enabled: z.boolean().default(true),
    /** Outros casos em que marcar retorno, além do lead pedir (ex.: "quando disser que vai falar com o sócio"). */
    when: z.string().trim().max(1000).default(""),
    /** Na hora: agent = o agente retoma a conversa; team = só as ações (a atividade para a equipe); both = os dois. */
    contact: z.enum(["agent", "team", "both"]).default("agent"),
    /** Orientação para a mensagem de retorno (o agente escreve pelo contexto da conversa). */
    guide: z.string().trim().max(2000).default(""),
    /** Caixa oficial com a janela de 24h fechada: envia este modelo (sem ele, a equipe é avisada). */
    template: FollowupTemplate.nullable().default(null),
    /** Horários em que o agente sugere o retorno (o horário pedido pelo lead vale como está). Nulo: o horário de atendimento. */
    window: WeeklyHours.nullable().default(null),
    /** Até quantos dias à frente o retorno pode ser marcado. */
    max_days: z.number().int().min(1).max(365).default(180),
    /** Com a IA desligada na conversa (uma pessoa assumiu): send = o agente retoma mesmo assim; skip = não manda (as ações valem). */
    when_ai_off: z.enum(["send", "skip"]).default("skip"),
    followup: z
      .object({
        /** pause: a régua espera o retorno; keep: segue normal. */
        during: z.enum(["pause", "keep"]).default("pause"),
        /** Depois da mensagem de retorno: restart = a régua conta a partir dela; stop = não volta. */
        after: z.enum(["restart", "stop"]).default("restart"),
      })
      .strict()
      .default({ during: "pause", after: "restart" }),
    /** Ao registrar o retorno. */
    on_create: CallbackActions.default(NONE),
    /** Na hora do retorno. */
    on_due: CallbackActions.default(NONE),
    /** O lead não respondeu ao retorno em X horas. */
    no_reply: z
      .object({ enabled: z.boolean().default(false), after_hours: z.number().int().min(1).max(720).default(24), actions: CallbackActions.default(NONE) })
      .strict()
      .default({ enabled: false, after_hours: 24, actions: NONE }),
    /** O lead adiou de novo: a partir do N-ésimo retorno pedido na conversa. */
    postponed: z
      .object({ enabled: z.boolean().default(false), from: z.number().int().min(2).max(10).default(2), actions: CallbackActions.default(NONE) })
      .strict()
      .default({ enabled: false, from: 2, actions: NONE }),
  })
  .strict()
  .refine((c) => c.contact === "agent" || !!c.on_due.activity || c.on_due.notify_team, {
    message: "Com a equipe fazendo o contato, crie uma atividade ou avise a equipe na hora do retorno.",
    path: ["on_due"],
  });

export type CallbacksT = z.infer<typeof Callbacks>;
export type CallbackActionsT = z.infer<typeof CallbackActions>;
