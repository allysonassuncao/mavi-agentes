import { z } from "zod";

/**
 * Etapas da conversa: o motor decide a etapa sem IA, pelo que já aconteceu
 * (dados registrados do contato, frases que o agente já mandou), e o prompt
 * da vez leva as instruções daquela etapa. Ex.: "Aprovado" quando a simulação
 * guardou o dado aprovacao; "Agendado" quando o agente já mandou "Agendado para
 * o dia". Assim a regra de pós-agendamento não disputa a atenção do modelo com
 * a de abertura.
 */

const slug = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "Use letras minúsculas, números e _ (começando por letra).");

export const StageRule = z.discriminatedUnion("type", [
  /** Um dado do contato (registrado pelo agente ou guardado por uma ação). */
  z
    .object({
      type: z.literal("fact"),
      field: z.string().trim().min(1).max(60),
      /** filled: tem valor; equals/contains: compara com `value` (sem diferenciar maiúsculas e acentos). */
      op: z.enum(["filled", "equals", "contains"]).default("filled"),
      value: z.string().trim().max(200).default(""),
    })
    .strict()
    .refine((r) => r.op === "filled" || !!r.value, { message: "Diga o valor para comparar.", path: ["value"] }),
  /** O agente já mandou uma mensagem com um destes textos nesta conversa (desde a retomada). */
  z
    .object({
      type: z.literal("said"),
      texts: z.array(z.string().trim().min(2).max(200)).min(1, "Escreva ao menos um texto.").max(10),
    })
    .strict(),
]);
export type StageRuleT = z.infer<typeof StageRule>;

export const Stage = z
  .object({
    id: slug,
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    /** Quando a conversa está nesta etapa. Sem regras: sempre (use como etapa inicial, por último). */
    when: z
      .object({
        mode: z.enum(["all", "any"]).default("any"),
        rules: z.array(StageRule).max(10).default([]),
      })
      .strict()
      .default({ mode: "any", rules: [] }),
    /** O que vale só nesta etapa (Markdown). Entra no prompt logo depois do roteiro. */
    instructions: z.string().max(20000).default(""),
    /** Nesta etapa o roteiro (Como conduzir a conversa) não vai no prompt. */
    hide_guide: z.boolean().default(false),
  })
  .strict();
export type StageT = z.infer<typeof Stage>;

export const Stages = z
  .object({
    enabled: z.boolean().default(false),
    /** De cima para baixo: vale a primeira etapa cujas regras batem. */
    items: z.array(Stage).max(12).default([]),
    /**
     * Retomada: o lead volta depois de tantos dias sem mensagem do agente →
     * a etapa recomeça (as frases de antes não contam e os dados usados nas
     * regras são apagados). null = nunca recomeça.
     */
    restart_after_days: z.number().int().min(1).max(365).nullable().default(null),
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    s.items.forEach((st, i) => {
      if (ids.has(st.id)) ctx.addIssue({ code: "custom", message: "Já existe outra etapa com este código.", path: ["items", i, "id"] });
      ids.add(st.id);
    });
    if (s.enabled && !s.items.some((st) => st.enabled)) ctx.addIssue({ code: "custom", message: "Cadastre ao menos uma etapa.", path: ["items"] });
  });
export type StagesT = z.infer<typeof Stages>;
