import { z } from "zod";
import { WeeklyHours } from "./weekly-hours.js";

/**
 * Integrações do agente (Fase 2): o que ele pode FAZER na conversa, cada uma
 * com a sua configuração. Executadas pelo próprio motor (sem n8n): Google
 * Agenda pelas contas conectadas no MakeCRM; oportunidade e responsáveis
 * direto no MakeCRM; aviso à equipe pelo WhatsApp de uma caixa.
 */

const id = z.string().trim().min(1).max(64);
const uuid = z.string().uuid();
const when = z.string().trim().min(3).max(600);

/** Um usuário do MakeCRM no rodízio (peso = quantos por vez; horário de trabalho do MakeCRM). */
export const RotationUser = z
  .object({ user_id: uuid, weight: z.number().int().min(1).max(100).default(1), work_hours: z.boolean().default(false) })
  .strict();

export const GoogleCalendar = z
  .object({
    type: z.literal("google_calendar"),
    enabled: z.boolean().default(true),
    /** Quem recebe as reuniões (usuários do MakeCRM com o Google conectado). */
    hosts: z.array(RotationUser).min(1).max(30),
    /** fixed: sempre o primeiro; round_robin: reveza pelos pesos. */
    distribution: z.enum(["fixed", "round_robin"]).default("fixed"),
    duration_minutes: z.number().int().min(10).max(240).default(30),
    /** Dias e horários em que o agente pode marcar. */
    allowed_hours: WeeklyHours,
    /** Antecedência mínima e até quantos dias à frente. */
    min_notice_minutes: z.number().int().min(0).max(4320).default(60),
    days_ahead: z.number().int().min(1).max(60).default(14),
    /** De quanto em quanto tempo começam os horários oferecidos. */
    slot_step_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(30),
    title: z.string().trim().min(1).max(200).default("Reunião com {lead}"),
    invite_lead: z.boolean().default(true),
    meet_link: z.boolean().default(true),
    /** Põe na descrição o resumo da conversa e os dados do lead. */
    add_summary: z.boolean().default(true),
    /** Quantos convidados além do lead o agente pode incluir (0 = nenhum). */
    max_guests: z.number().int().min(0).max(10).default(3),
    /** Os convidados veem os e-mails uns dos outros no convite. */
    guests_see_others: z.boolean().default(true),
  })
  .strict();

export const MoveDealRule = z.object({ id, when, pipeline_id: uuid, stage_id: uuid }).strict();
export const MoveDeal = z
  .object({
    type: z.literal("makecrm_move_deal"),
    enabled: z.boolean().default(true),
    rules: z.array(MoveDealRule).min(1).max(30),
    /** Dispara as automações do MakeCRM (as mesmas de quando alguém move pela tela). */
    run_automations: z.boolean().default(true),
  })
  .strict();

export const RoleTarget = z
  .object({
    mode: z.enum(["fixed", "round_robin"]),
    user_id: uuid.optional(),
    users: z.array(RotationUser).max(30).default([]),
  })
  .strict()
  .refine((r) => (r.mode === "fixed" ? !!r.user_id : r.users.length > 0), "Escolha o usuário (fixo) ou quem entra no rodízio.");

export const ChangeOwnerRule = z
  .object({
    id,
    when,
    /** Proprietário (user_id), SDR e Closer da oportunidade. */
    owner: RoleTarget.optional(),
    sdr: RoleTarget.optional(),
    closer: RoleTarget.optional(),
    /** Leva o mesmo responsável para a conversa no MakeCRM. */
    sync_conversation: z.boolean().default(true),
    /** Desliga a IA na conversa depois de trocar (a pessoa assume). */
    turn_off_ai: z.boolean().default(false),
  })
  .strict()
  .refine((r) => r.owner || r.sdr || r.closer, "Escolha ao menos um papel (proprietário, SDR ou closer).");

export const ChangeOwner = z
  .object({
    type: z.literal("makecrm_change_owner"),
    enabled: z.boolean().default(true),
    rules: z.array(ChangeOwnerRule).min(1).max(30),
  })
  .strict();

export const TeamNotify = z
  .object({
    type: z.literal("team_notify"),
    enabled: z.boolean().default(true),
    /** Caixa de WhatsApp (QR Code/Uazapi) que envia o aviso. */
    inbox_id: uuid,
    phones: z.array(z.string().regex(/^\d{10,15}$/, "Telefone com DDI e DDD, só números (ex.: 5511999999999).")).min(1).max(10),
    /** Quando avisar (o agente decide pela conversa). */
    when: z.string().trim().min(3).max(1000),
  })
  .strict();

/**
 * Quem fica com a atividade criada pelo agente: a pessoa de um papel da
 * oportunidade (com quem assume quando o papel está vazio), uma pessoa fixa
 * ou um rodízio entre pessoas.
 */
export const ActivityAssignee = z
  .object({
    mode: z.enum(["deal_role", "fixed", "round_robin"]).default("deal_role"),
    role: z.enum(["owner", "sdr", "closer"]).default("owner"),
    /** fixed: a pessoa; deal_role: quem assume se a oportunidade não tiver ninguém no papel. */
    user_id: uuid.nullable().default(null),
    users: z.array(RotationUser).max(30).default([]),
  })
  .strict()
  .refine((a) => (a.mode === "fixed" ? !!a.user_id : a.mode === "round_robin" ? a.users.length > 0 : true), "Escolha a pessoa (fixa) ou quem entra no rodízio.");

const Named = z.object({ id: uuid, name: z.string().trim().max(200).default("") }).strict();
const guide = z.string().trim().max(1000).default("");

/**
 * Ações na oportunidade do MakeCRM, como na tela do MakeCRM (mesmo histórico,
 * mesmos webhooks de automação): dar como perdido ou ganho, criar orçamento,
 * registrar no histórico e criar atividade. Cada uma liga à parte.
 */
export const DealActions = z
  .object({
    type: z.literal("makecrm_deal_actions"),
    enabled: z.boolean().default(true),
    lost: z
      .object({
        enabled: z.boolean().default(false),
        /** Quando dar como perdido (além do que os Cenários já fazem). */
        when: guide,
        /** Motivos de perda que o agente pode usar (os da empresa no MakeCRM). */
        reasons: z.array(Named).max(50).default([]),
        /** Como na tela: cancela as reuniões futuras e conclui as atividades em aberto. */
        cancel_meetings: z.boolean().default(true),
        complete_activities: z.boolean().default(true),
      })
      .strict()
      .default({ enabled: false, when: "", reasons: [], cancel_meetings: true, complete_activities: true }),
    won: z
      .object({ enabled: z.boolean().default(false), when: guide })
      .strict()
      .default({ enabled: false, when: "" }),
    quote: z
      .object({
        enabled: z.boolean().default(false),
        when: guide,
        /** Produtos do catálogo do MakeCRM que o agente pode orçar, com o desconto máximo sobre o preço cadastrado. */
        products: z
          .array(z.object({ product_id: uuid, name: z.string().trim().max(300).default(""), max_discount_pct: z.number().min(0).max(100).default(0) }).strict())
          .max(50)
          .default([]),
      })
      .strict()
      .default({ enabled: false, when: "", products: [] }),
    note: z
      .object({ enabled: z.boolean().default(false), when: guide })
      .strict()
      .default({ enabled: false, when: "" }),
    activity: z
      .object({
        enabled: z.boolean().default(false),
        when: guide,
        /** Tipos de atividade do MakeCRM que o agente pode criar. */
        types: z.array(Named).max(20).default([]),
        assignee: ActivityAssignee.default({ mode: "deal_role", role: "owner", user_id: null, users: [] }),
        /** Prazo quando o lead não combinou um dia (horas a partir de agora). */
        default_due_hours: z.number().int().min(0).max(720).default(24),
      })
      .strict()
      .default({ enabled: false, when: "", types: [], assignee: { mode: "deal_role", role: "owner", user_id: null, users: [] }, default_due_hours: 24 }),
  })
  .strict()
  .refine((d) => d.lost.enabled || d.won.enabled || d.quote.enabled || d.note.enabled || d.activity.enabled, "Ligue ao menos uma ação.")
  .refine((d) => !d.lost.enabled || d.lost.reasons.length > 0, { message: "Escolha os motivos de perda que o agente pode usar.", path: ["lost", "reasons"] })
  .refine((d) => !d.quote.enabled || d.quote.products.length > 0, { message: "Escolha os produtos que o agente pode orçar.", path: ["quote", "products"] })
  .refine((d) => !d.activity.enabled || d.activity.types.length > 0, { message: "Escolha os tipos de atividade.", path: ["activity", "types"] });

export const Integration = z.discriminatedUnion("type", [GoogleCalendar, MoveDeal, ChangeOwner, TeamNotify, DealActions]);
export type Integration = z.infer<typeof Integration>;
export type GoogleCalendarConfig = z.infer<typeof GoogleCalendar>;
export type MoveDealConfig = z.infer<typeof MoveDeal>;
export type ChangeOwnerConfig = z.infer<typeof ChangeOwner>;
export type TeamNotifyConfig = z.infer<typeof TeamNotify>;
export type DealActionsConfig = z.infer<typeof DealActions>;
export type ActivityAssigneeT = z.infer<typeof ActivityAssignee>;
export type RotationUserT = z.infer<typeof RotationUser>;
export type RoleTargetT = z.infer<typeof RoleTarget>;
