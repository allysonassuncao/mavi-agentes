import { z } from "zod";

/**
 * Ações: contas e validações que o agente faz na conversa sem depender de
 * outro sistema (ex.: simulação de parcelas, validar CPF). Montadas em blocos
 * na aba Ações do construtor: os dados que o agente preenche, os passos
 * (calcular, se/senão, parar e responder, montar texto) e o texto do
 * resultado. Cada ação vira a ferramenta acao_<id>. Nada sai do motor, então
 * dá para refazer à vontade.
 */

const text = (max: number) => z.string().trim().max(max);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "Use minúsculas, números e _ (começando com letra).");

export const ACTION_INPUT_TYPES = ["text", "number", "money", "integer", "boolean", "date", "cpf", "cnpj", "email", "phone", "choice"] as const;
export type ActionInputType = (typeof ACTION_INPUT_TYPES)[number];

/** Um dado da ação: o agente preenche pela conversa ou vem do contato. CPF, CNPJ, e-mail, telefone e data são validados sozinhos. */
export const ActionInput = z
  .object({
    id: slug,
    label: text(80).min(1, "Dê um nome ao dado."),
    type: z.enum(ACTION_INPUT_TYPES).default("text"),
    description: text(300).default(""),
    required: z.boolean().default(true),
    /** choice: as opções aceitas. */
    options: z.array(text(120).min(1)).max(30).default([]),
    source: z.enum(["agent", "contact"]).default("agent"),
    /** contact: phone, name ou fact:<campo>. */
    value: text(80).default(""),
  })
  .strict()
  .refine((i) => i.type !== "choice" || i.options.length > 0, { message: "Cadastre as opções da lista.", path: ["options"] })
  .refine((i) => i.source !== "contact" || /^(phone|name|fact:[A-Za-z0-9_]{1,60})$/.test(i.value), { message: "Escolha o dado do contato.", path: ["value"] });

/** Um valor num bloco: um dado (ou conta anterior), um número ou um texto fixo. */
export const Operand = z.union([z.object({ var: slug }).strict(), z.object({ number: z.number().finite() }).strict(), z.object({ text: text(200) }).strict()]);
export type OperandT = z.infer<typeof Operand>;

export const Term = z.object({ op: z.enum(["+", "-", "*", "/", "min", "max"]).default("+"), value: Operand }).strict();

export const Condition = z
  .object({
    left: Operand,
    cmp: z.enum(["<", "<=", ">", ">=", "=", "!=", "contains", "empty", "filled"]),
    right: Operand.nullable().default(null),
  })
  .strict()
  .refine((c) => c.cmp === "empty" || c.cmp === "filled" || c.right !== null, { message: "Escolha com o que comparar.", path: ["right"] });

export const When = z
  .object({
    /** all: todas as regras; any: qualquer uma. */
    mode: z.enum(["all", "any"]).default("all"),
    rules: z.array(Condition).min(1).max(10),
  })
  .strict();

export type ConditionT = z.infer<typeof Condition>;
export type WhenT = z.infer<typeof When>;

/** Os blocos. "set": calcula da esquerda para a direita; "if": se/senão (até 3 níveis); "stop": para e devolve a mensagem; "text": monta um texto. */
export type ActionStep =
  | { id: string; kind: "set"; target: string; first: OperandT; terms: z.infer<typeof Term>[]; round: number | null }
  | { id: string; kind: "if"; when: WhenT; then: ActionStep[]; else: ActionStep[] }
  | { id: string; kind: "stop"; message: string }
  | { id: string; kind: "text"; target: string; template: string };

const stepId = z.string().trim().min(1).max(40);
export const ActionStepSchema: z.ZodType<ActionStep> = z.lazy(() =>
  z.union([
    z.object({ id: stepId, kind: z.literal("set"), target: slug, first: Operand, terms: z.array(Term).max(10).default([]), round: z.number().int().min(0).max(4).nullable().default(2) }).strict(),
    z.object({ id: stepId, kind: z.literal("if"), when: When, then: z.array(ActionStepSchema).max(20).default([]), else: z.array(ActionStepSchema).max(20).default([]) }).strict(),
    z.object({ id: stepId, kind: z.literal("stop"), message: text(1000).min(1, "Escreva a mensagem.") }).strict(),
    z.object({ id: stepId, kind: z.literal("text"), target: slug, template: text(1000).min(1, "Escreva o texto.") }).strict(),
  ]),
) as z.ZodType<ActionStep>;

/** Referências {dado} e {dado:formato} num texto. */
export const TEMPLATE_FORMATS = ["dinheiro", "numero", "inteiro", "porcentagem"] as const;
export function templateVars(template: string): { name: string; format: string | null }[] {
  return [...template.matchAll(/\{([a-z][a-z0-9_]*)(?::([a-z]+))?\}/g)].map((m) => ({ name: m[1]!, format: m[2] ?? null }));
}

/** Os nomes que um dado gera (a data também dá a idade em anos e o dia da semana, ex.: "sábado"). */
export const inputVars = (i: { id: string; type: ActionInputType }) => (i.type === "date" ? [i.id, `${i.id}_idade`, `${i.id}_dia_semana`] : [i.id]);

/**
 * Dados que toda ação já tem, sem pedir: a data e a hora de agora (Brasília) e
 * um número de protocolo novo a cada vez (AAMMDD + 4 dígitos).
 */
export const BUILTIN_VARS = ["hoje", "hora_agora", "protocolo"] as const;

const operandVar = (o: OperandT | null) => (o && "var" in o ? o.var : null);

export const Action = z
  .object({
    /** Vira o nome da ferramenta (acao_<id>). */
    id: slug,
    enabled: z.boolean().default(true),
    name: text(80).min(1, "Dê um nome à ação."),
    /** Quando o agente deve usar (vai para o modelo como a descrição da ferramenta). */
    when: text(1000).min(3, "Diga quando o agente deve usar esta ação."),
    inputs: z.array(ActionInput).max(20).default([]),
    steps: z.array(ActionStepSchema).max(30).default([]),
    result: z
      .object({
        /** O texto que o agente recebe no fim, com {dado} e {dado:dinheiro}. */
        message: text(2000).default(""),
        /** Como o agente deve usar o resultado. */
        instructions: text(1000).default(""),
        /** Dados e contas que ficam guardados no contato (não pergunta de novo). */
        save_facts: z.array(slug).max(20).default([]),
      })
      .strict()
      .default({ message: "", instructions: "", save_facts: [] }),
  })
  .strict()
  .superRefine((a, ctx) => {
    const ids = new Set<string>();
    a.inputs.forEach((i, idx) => {
      if (ids.has(i.id)) ctx.addIssue({ code: "custom", message: "Dois dados com o mesmo código.", path: ["inputs", idx, "id"] });
      for (const v of inputVars(i)) ids.add(v);
    });
    const known = new Set([...ids, ...BUILTIN_VARS]);
    for (const b of BUILTIN_VARS) ids.add(b);
    let total = 0;
    // Percorre na ordem: um bloco só usa o que veio antes (dados ou contas de blocos anteriores).
    const walk = (steps: ActionStep[], path: (string | number)[], depth: number) => {
      if (depth > 3) ctx.addIssue({ code: "custom", message: "No máximo 3 níveis de se/senão.", path });
      const stepIds = new Set<string>();
      steps.forEach((s, i) => {
        total++;
        const p = [...path, i];
        if (stepIds.has(s.id)) ctx.addIssue({ code: "custom", message: "Dois blocos com o mesmo código.", path: [...p, "id"] });
        stepIds.add(s.id);
        const need = (name: string | null, where: (string | number)[]) => {
          if (name && !known.has(name)) ctx.addIssue({ code: "custom", message: `"${name}" ainda não existe neste ponto: use um dado ou uma conta de um bloco anterior.`, path: [...p, ...where] });
        };
        const needText = (t: string, where: (string | number)[]) => {
          for (const v of templateVars(t)) {
            if (!known.has(v.name)) ctx.addIssue({ code: "custom", message: `{${v.name}} não existe neste ponto.`, path: [...p, ...where] });
            if (v.format && !(TEMPLATE_FORMATS as readonly string[]).includes(v.format))
              ctx.addIssue({ code: "custom", message: `Formato desconhecido em {${v.name}:${v.format}} (use ${TEMPLATE_FORMATS.join(", ")}).`, path: [...p, ...where] });
          }
        };
        if (s.kind === "set") {
          need(operandVar(s.first), ["first"]);
          s.terms.forEach((t, j) => need(operandVar(t.value), ["terms", j, "value"]));
          if (ids.has(s.target)) ctx.addIssue({ code: "custom", message: "Esse nome já é de um dado: escolha outro para a conta.", path: [...p, "target"] });
          known.add(s.target);
        } else if (s.kind === "text") {
          needText(s.template, ["template"]);
          if (ids.has(s.target)) ctx.addIssue({ code: "custom", message: "Esse nome já é de um dado: escolha outro.", path: [...p, "target"] });
          known.add(s.target);
        } else if (s.kind === "stop") needText(s.message, ["message"]);
        else {
          s.when.rules.forEach((r, j) => {
            need(operandVar(r.left), ["when", "rules", j, "left"]);
            need(operandVar(r.right), ["when", "rules", j, "right"]);
          });
          walk(s.then, [...p, "then"], depth + 1);
          walk(s.else, [...p, "else"], depth + 1);
        }
      });
    };
    walk(a.steps, ["steps"], 1);
    if (total > 60) ctx.addIssue({ code: "custom", message: "Ação grande demais: no máximo 60 blocos.", path: ["steps"] });
    for (const v of templateVars(a.result.message))
      if (!known.has(v.name)) ctx.addIssue({ code: "custom", message: `{${v.name}} não existe: use um dado ou uma conta.`, path: ["result", "message"] });
    a.result.save_facts.forEach((f, i) => {
      if (!known.has(f)) ctx.addIssue({ code: "custom", message: `"${f}" não existe nesta ação.`, path: ["result", "save_facts", i] });
    });
    if (!a.result.message && !a.steps.some((s) => s.kind === "stop") && !a.inputs.length)
      ctx.addIssue({ code: "custom", message: "A ação não faz nada: adicione dados, blocos ou o texto do resultado.", path: ["result", "message"] });
  });

export const Actions = z
  .array(Action)
  .max(20)
  .default([])
  .superRefine((list, ctx) => {
    const ids = new Set<string>();
    list.forEach((a, i) => {
      if (ids.has(a.id)) ctx.addIssue({ code: "custom", message: "Já existe outra ação com este código.", path: [i, "id"] });
      ids.add(a.id);
    });
  });

export type ActionT = z.infer<typeof Action>;
export type ActionInputT = z.infer<typeof ActionInput>;
export const ACTION_TOOL_PREFIX = "acao_";
export const actionToolName = (id: string) => `${ACTION_TOOL_PREFIX}${id}`;
