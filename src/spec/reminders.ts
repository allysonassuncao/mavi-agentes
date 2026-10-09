import { z } from "zod";
import { FollowupTemplate } from "./followup.js";
import { WeeklyHours } from "./weekly-hours.js";

/**
 * Régua de pré-reunião: o agente fala com o lead em volta das reuniões que
 * ele mesmo marcou — X minutos antes (lembrete, pedido de confirmação) e
 * depois do fim (agradecimento, "sentimos sua falta"). Remarcou: a régua
 * acompanha o novo horário; cancelou: para.
 */

export const ReminderStep = z
  .object({
    id: z.string().trim().min(1).max(40),
    /** before: antes do início; after: depois do fim. */
    when: z.enum(["before", "after"]).default("before"),
    /** Minutos antes do início (ou depois do fim). */
    minutes: z.number().int().min(5).max(20_160),
    /** ai: a MAVI escreve pelo contexto seguindo a orientação; fixed: o texto como está (com as variáveis). */
    mode: z.enum(["ai", "fixed"]).default("fixed"),
    text: z.string().trim().max(2000).default(""),
    /** Esta etapa pede para o lead confirmar presença (só antes da reunião). */
    confirm: z.boolean().default(false),
    /** Caixa oficial com a janela de 24h fechada: envia este modelo (sem ele, a etapa é pulada). */
    template: FollowupTemplate.nullable().default(null),
  })
  .strict()
  .refine((s) => s.mode === "ai" || s.text.length > 0, { message: "Etapa com texto fixo precisa do texto.", path: ["text"] })
  .refine((s) => !s.confirm || s.when === "before", { message: "Só dá para pedir confirmação antes da reunião.", path: ["confirm"] });

export const MeetingReminders = z
  .object({
    enabled: z.boolean().default(true),
    steps: z.array(ReminderStep).min(1).max(10),
    /** Só envia nestes dias/horários: fora deles, a etapa vai para a abertura seguinte (se ainda for antes da reunião). Nulo: qualquer hora. */
    window: WeeklyHours.nullable().default(null),
    /** Com a IA desligada na conversa (uma pessoa assumiu): send = os lembretes continuam; skip = não saem. */
    when_ai_off: z.enum(["send", "skip"]).default("send"),
    /** Confirmação (das etapas que pedem). */
    confirmation: z
      .object({
        /** Sem confirmação até X minutos antes do início: avisa a equipe (null = não avisa). */
        alert_minutes_before: z.number().int().min(5).max(10_080).nullable().default(60),
        /** O lead disse que não vai: avisa a equipe. */
        notify_on_decline: z.boolean().default(true),
      })
      .strict()
      .default({ alert_minutes_before: 60, notify_on_decline: true }),
  })
  .strict()
  .refine((r) => new Set(r.steps.map((s) => `${s.when}:${s.minutes}`)).size === r.steps.length, "Duas etapas no mesmo momento.");

export type MeetingRemindersT = z.infer<typeof MeetingReminders>;
export type ReminderStepT = z.infer<typeof ReminderStep>;
