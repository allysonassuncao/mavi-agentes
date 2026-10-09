import { z } from "zod";

// Mensagens de validação em português (vão para quem constrói o agente).
z.config(z.locales.ptBR());

/**
 * Especificação do agente — o contrato entre quem constrói (MAVI Tasks,
 * construtor do MakeCRM) e este motor. Versão 1.
 *
 * Tudo tem padrão: um rascunho novo só precisa de persona.name, persona.company
 * e instructions.goal para funcionar. Campos desconhecidos são recusados
 * (strict) para um erro de digitação não virar configuração ignorada.
 */

const text = (max: number) => z.string().max(max);
const list = (maxItems: number, maxLen: number) => z.array(z.string().trim().min(1).max(maxLen)).max(maxItems);

export const Persona = z
  .object({
    /** Nome com que o agente se apresenta ("Clara"). */
    name: z.string().trim().min(1).max(60),
    role: text(120).default("assistente virtual"),
    company: z.string().trim().min(1).max(120),
    company_summary: text(4000).default(""),
    segment: text(120).default(""),
    address: text(400).default(""),
    language: text(60).default("português do Brasil"),
    tone: text(300).default("cordial, natural e direto, como uma pessoa real no WhatsApp"),
    reply_size: z.enum(["short", "medium", "long"]).default("short"),
    emoji: z.enum(["none", "few", "many"]).default("few"),
  })
  .strict();

export { WeeklyHours } from "./weekly-hours.js";
export type { WeeklyHours as WeeklyHoursT } from "./weekly-hours.js";
import { WeeklyHours } from "./weekly-hours.js";
import { Integration } from "./integrations.js";
import { Followup } from "./followup.js";
import { Scenarios } from "./scenarios.js";
import { MeetingReminders } from "./reminders.js";

export const Instructions = z
  .object({
    goal: z.string().trim().min(1).max(4000),
    /** Roteiro da conversa (perguntas, etapas, ordem). Markdown. */
    conversation_guide: text(20000).default(""),
    rules: list(60, 1000).default([]),
    never: list(60, 1000).default([]),
    /** Observações sobre horários (feriados, plantão…). */
    business_hours: text(2000).default(""),
    weekly_hours: WeeklyHours.nullable().default(null),
    /** Texto livre (prompts trazidos do n8n entram aqui enquanto não são quebrados em blocos). */
    extra: text(60000).default(""),
  })
  .strict();

export const Knowledge = z
  .object({
    enabled: z.boolean().default(true),
    /** Quantos trechos a pré-busca põe na mensagem da vez (0 = só pela ferramenta). */
    prefetch_k: z.number().int().min(0).max(20).default(6),
    /** Ferramenta buscar_conhecimento para o agente pesquisar mais. */
    search_tool: z.boolean().default(true),
    /** Reordena os candidatos com um LLM (mais preciso, ~1 s a mais). */
    rerank: z.boolean().default(false),
  })
  .strict();

export const Memory = z
  .object({
    /** Mensagens recentes que vão inteiras; as anteriores viram resumo. */
    history_messages: z.number().int().min(4).max(100).default(30),
    summary: z.boolean().default(true),
    /** Dados que o agente deve coletar e guardar (ex.: "nome", "e-mail", "cidade"). */
    contact_fields: list(30, 60).default([]),
  })
  .strict();

export const Media = z
  .object({
    audio: z.boolean().default(true),
    images: z.boolean().default(true),
    documents: z.boolean().default(true),
  })
  .strict();

export const Buffer = z
  .object({
    /** Espera depois da última mensagem do lead antes de responder. */
    seconds: z.number().int().min(0).max(60).default(8),
  })
  .strict();

export const Output = z
  .object({
    max_messages: z.number().int().min(1).max(8).default(4),
    /** Pausa entre as mensagens proporcional ao tamanho (parece digitação). */
    typing_delay: z.boolean().default(true),
    strip_trailing_period: z.boolean().default(true),
    /** Troca travessão (—) por vírgula/reticências: denuncia texto de IA. */
    no_em_dash: z.boolean().default(true),
  })
  .strict();

const Pricing = z
  .object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000), cached: z.number().min(0).max(1000).nullable().optional() })
  .strict();

export const Model = z
  .object({
    /** "<provedor>:<modelo>" (ex.: "openrouter:openai/gpt-5.2"); null = padrão do motor. */
    model: z.string().trim().min(1).max(160).nullable().default(null),
    fallback_model: z.string().trim().min(1).max(160).nullable().default(null),
    /** Preço por milhão de tokens (do Painel da MAVI), para provedores que não devolvem o custo. */
    pricing: Pricing.nullable().default(null),
    fallback_pricing: Pricing.nullable().default(null),
    temperature: z.number().min(0).max(2).nullable().default(null),
    effort: z.enum(["low", "medium", "high"]).nullable().default(null),
  })
  .strict();

export const Handoff = z
  .object({
    enabled: z.boolean().default(true),
    /** Quando passar para uma pessoa (além de quando o lead pedir). */
    when: text(2000).default(""),
    /** O que dizer ao lead ao passar (vazio = o agente decide). */
    message: text(500).default(""),
  })
  .strict();

/** Ferramentas configuráveis (Fase 2+). Por enquanto só guardadas. */
export const ToolRef = z
  .object({
    type: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
    description: text(1000).default(""),
    config: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export const AgentSpec = z
  .object({
    schema: z.literal("mavi-agent/v1").default("mavi-agent/v1"),
    persona: Persona,
    instructions: Instructions,
    knowledge: Knowledge.default(Knowledge.parse({})),
    memory: Memory.default(Memory.parse({})),
    media: Media.default(Media.parse({})),
    buffer: Buffer.default(Buffer.parse({})),
    output: Output.default(Output.parse({})),
    model: Model.default(Model.parse({})),
    handoff: Handoff.default(Handoff.parse({})),
    /** O que o agente pode fazer: Google Agenda, oportunidade e responsáveis no MakeCRM, aviso à equipe. */
    integrations: z.array(Integration).max(10).default([]),
    /** Situações fora do roteiro com ações combinadas ("quando o lead pedir X, faça Y"). */
    scenarios: Scenarios,
    /** Régua de follow-up quando o lead para de responder. */
    followup: Followup.nullable().default(null),
    /** Régua de pré-reunião: mensagens antes e depois das reuniões marcadas pelo agente. */
    meeting_reminders: MeetingReminders.nullable().default(null),
    tools: z.array(ToolRef).max(40).default([]),
    automations: z.array(z.record(z.string(), z.unknown())).max(40).default([]),
  })
  .strict();

export type AgentSpec = z.infer<typeof AgentSpec>;
export type AgentSpecInput = z.input<typeof AgentSpec>;

/** Valida e completa com os padrões. Erros em português, com o caminho do campo. */
export function parseSpec(input: unknown): { ok: true; spec: AgentSpec } | { ok: false; errors: { path: string; message: string }[] } {
  const r = AgentSpec.safeParse(input);
  if (r.success) return { ok: true, spec: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}
