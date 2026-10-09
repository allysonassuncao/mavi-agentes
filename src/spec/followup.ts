import { z } from "zod";
import { WeeklyHours } from "./weekly-hours.js";

/**
 * Régua de follow-up: quando o lead para de responder, o agente retoma a
 * conversa em etapas. Cada etapa conta a partir da última mensagem do agente
 * (a etapa anterior também é uma); o lead respondeu, a régua para e recomeça
 * do zero na próxima vez que ele sumir.
 */

export const FollowupTemplate = z
  .object({
    /** Modelo aprovado do WhatsApp Business API (inbox_whatsapp_business_templates.template_id). */
    template_id: z.string().trim().min(1).max(200),
    /** Valores das variáveis do corpo, na ordem ({nome}, {primeiro_nome}, {agente}, {empresa} viram os dados). */
    params: z.array(z.string().max(500)).max(20).default([]),
  })
  .strict();

export const FollowupStep = z
  .object({
    id: z.string().trim().min(1).max(40),
    /** Minutos sem resposta desde a última mensagem do agente. */
    after_minutes: z.number().int().min(5).max(43_200),
    /** ai: a IA escreve pelo contexto seguindo a orientação; fixed: o texto como está. */
    mode: z.enum(["ai", "fixed"]).default("ai"),
    text: z.string().trim().max(2000).default(""),
    /** Caixa oficial com a janela de 24h fechada: envia este modelo (sem ele, a etapa é pulada). */
    template: FollowupTemplate.nullable().default(null),
  })
  .strict()
  .refine((s) => s.mode === "ai" || s.text.length > 0, "Etapa com texto fixo precisa do texto.");

export const Followup = z
  .object({
    enabled: z.boolean().default(true),
    steps: z.array(FollowupStep).min(1).max(10),
    /** Só envia nestes dias/horários (fora deles, espera abrir). Nulo: qualquer hora. */
    window: WeeklyHours.nullable().default(null),
    /** Não retoma quem já tem reunião marcada pelo agente. */
    skip_if_meeting: z.boolean().default(true),
    /** Quando a régua termina sem resposta. */
    on_finish: z
      .object({
        move: z.object({ pipeline_id: z.string().uuid(), stage_id: z.string().uuid() }).strict().nullable().default(null),
        /** Aviso para a equipe (pelo WhatsApp configurado em Integrações › Avisar a equipe). */
        notify: z.string().trim().max(1000).nullable().default(null),
        turn_off_ai: z.boolean().default(false),
      })
      .strict()
      .default({ move: null, notify: null, turn_off_ai: false }),
  })
  .strict();

export type FollowupT = z.infer<typeof Followup>;
export type FollowupStepT = z.infer<typeof FollowupStep>;
