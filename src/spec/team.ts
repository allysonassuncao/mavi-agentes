import { z } from "zod";
import { WeeklyHours } from "./weekly-hours.js";

/**
 * Consulta à equipe: quando o lead pergunta algo que o agente não sabe (não
 * está nas instruções nem no conhecimento), o agente avisa o lead que vai
 * confirmar, manda a dúvida para a equipe pelo WhatsApp (telefones ou um
 * grupo, saindo de uma caixa por QR Code) e só responde depois que a equipe
 * responde, citando a mensagem ou com o código. A resposta pode virar
 * pergunta frequente na base. Sem resposta a tempo: lembrar a equipe,
 * transferir para uma pessoa ou desistir com elegância.
 */

const text = (max: number) => z.string().trim().max(max);
const phone = z.string().regex(/^\d{10,15}$/, "Telefone com DDI e DDD, só números (ex.: 5511999999999).");

export const TeamChannel = z
  .object({
    /** phones: cada pessoa recebe no próprio WhatsApp; group: um grupo da equipe. */
    mode: z.enum(["phones", "group"]).default("phones"),
    /** Caixa de WhatsApp (QR Code/Uazapi) que envia a dúvida e recebe a resposta. */
    inbox_id: z.string().uuid(),
    phones: z.array(phone).max(10).default([]),
    /** O grupo (id do WhatsApp, ex.: 120363…@g.us) e o nome, para mostrar. */
    group_id: text(120).default(""),
    group_name: text(200).default(""),
  })
  .strict()
  .refine((c) => c.mode !== "phones" || c.phones.length > 0, { message: "Cadastre ao menos um telefone da equipe.", path: ["phones"] })
  .refine((c) => c.mode !== "group" || /^\d{10,30}(-\d+)?@g\.us$/.test(c.group_id), { message: "Escolha o grupo da equipe.", path: ["group_id"] });

export const TeamTimeout = z
  .object({
    /** Minutos sem resposta da equipe até agir. */
    minutes: z.number().int().min(2).max(1440).default(15),
    /** remind: lembra a equipe e segue segurando; handoff: passa para uma pessoa; give_up: o agente diz que não conseguiu confirmar. */
    action: z.enum(["remind", "handoff", "give_up"]).default("remind"),
    /** remind: quantos lembretes no máximo (depois, segue esperando sem lembrar). */
    max_reminders: z.number().int().min(1).max(5).default(2),
    /** give_up: orientação para a mensagem ao lead (ex.: "ofereça a visita à loja"). */
    give_up_guide: text(1000).default(""),
  })
  .strict();

export const TeamQuestions = z
  .object({
    enabled: z.boolean().default(true),
    channel: TeamChannel,
    /** Quando consultar, além do padrão (o que não está nas instruções nem no conhecimento). */
    when: text(1000).default(""),
    /** O que nunca consultar (ex.: "parcela, aprovação, desconto, placa"). */
    never: text(1000).default(""),
    /** Orientação para o que dizer ao lead enquanto espera (vazio = o agente decide). */
    hold_guide: text(500).default(""),
    timeout: TeamTimeout.default({ minutes: 15, action: "remind", max_reminders: 2, give_up_guide: "" }),
    /** Só conta o tempo nestes dias/horários (null = sempre). Fora deles, espera abrir. */
    window: WeeklyHours.nullable().default(null),
    learn: z
      .object({
        /** A resposta da equipe vira pergunta frequente na base ("veio da equipe"). */
        enabled: z.boolean().default(true),
        /** O que não guardar porque muda (o agente decide pela dúvida). */
        skip: text(500).default("preço, disponibilidade, estoque ou qualquer condição que muda com o tempo"),
      })
      .strict()
      .default({ enabled: true, skip: "preço, disponibilidade, estoque ou qualquer condição que muda com o tempo" }),
  })
  .strict();

export type TeamQuestionsT = z.infer<typeof TeamQuestions>;
export const TEAM_TOOL = "consultar_equipe";
