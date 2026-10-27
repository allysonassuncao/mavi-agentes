import { z } from "zod";

/**
 * Conferência da resposta: antes de enviar, o motor confere a resposta com
 * regras em código (sem IA). O que barrar volta ao agente com o motivo para
 * ele reescrever; se continuar errado depois das tentativas, o grave não sai
 * (vai a mensagem de segurança) e o leve sai assim mesmo. Tudo fica no rastro.
 *
 * Padrões: texto simples (sem diferenciar maiúsculas e acentos) ou expressão
 * regular entre barras ("/foi aprovad[oa]/i").
 */

const slug = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "Use letras minúsculas, números e _ (começando por letra).");

/** "/…/flags" vira expressão regular; o resto é texto simples. */
export function patternRegex(p: string): RegExp | null {
  const m = p.match(/^\/(.+)\/([a-z]*)$/s);
  if (!m) return null;
  try {
    return new RegExp(m[1]!, m[2]!.replace(/[^imsu]/g, ""));
  } catch {
    return null;
  }
}

const patterns = z.array(z.string().trim().min(1).max(400)).max(30).default([]);

export const GuardCheck = z
  .object({
    id: slug,
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    /** grave: não sai se continuar errado; leve: tenta corrigir, mas sai mesmo assim. */
    severity: z.enum(["grave", "leve"]).default("grave"),
    /**
     * forbidden: a resposta não pode ter nenhum dos padrões.
     * requires: se a resposta tem um dos padrões, precisa ter vindo de uma ferramenta desta vez ou de um dado já registrado.
     * number_source: os números dos padrões (o 1º grupo entre parênteses, ou o trecho todo) precisam ter vindo das ferramentas, da conversa ou dos dados.
     * max_questions: no máximo `max` perguntas (?) na resposta.
     * question_last: se tem pergunta, ela é a última frase da última mensagem.
     */
    kind: z.enum(["forbidden", "requires", "number_source", "max_questions", "question_last"]),
    patterns,
    /** requires: ferramentas que liberam (ex.: acao_simulacao, api_estoque). Vale a que deu certo nesta vez. */
    tools: z.array(z.string().trim().min(2).max(64)).max(10).default([]),
    /** requires: dados do contato que liberam (basta um preenchido). */
    facts: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
    max: z.number().int().min(0).max(10).default(1),
    /** Só nestas etapas da conversa (vazio = em todas). */
    stages: z.array(slug).max(12).default([]),
    /** Só fora destas etapas. */
    skip_stages: z.array(slug).max(12).default([]),
    /** O motivo, como o agente lê para corrigir (ex.: "anunciou aprovação sem a simulação"). */
    message: z.string().trim().min(3).max(500),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.kind === "forbidden" || c.kind === "requires" || c.kind === "number_source") && !c.patterns.length)
      ctx.addIssue({ code: "custom", message: "Cadastre ao menos um padrão.", path: ["patterns"] });
    if (c.kind === "requires" && !c.tools.length && !c.facts.length)
      ctx.addIssue({ code: "custom", message: "Diga que ferramenta ou dado libera esta resposta.", path: ["tools"] });
    c.patterns.forEach((p, i) => {
      if (p.startsWith("/") && /\/[a-z]*$/.test(p) && p.length > 2 && !patternRegex(p))
        ctx.addIssue({ code: "custom", message: "Expressão regular inválida.", path: ["patterns", i] });
    });
  });
export type GuardCheckT = z.infer<typeof GuardCheck>;

export const Guard = z
  .object({
    enabled: z.boolean().default(false),
    /** Quantas vezes o agente pode reescrever uma resposta barrada. */
    retries: z.number().int().min(0).max(3).default(2),
    checks: z.array(GuardCheck).max(40).default([]),
    /** O que vai ao lead quando um problema grave continua (vazio = não responde). */
    fallback_message: z.string().trim().max(1000).default(""),
  })
  .strict()
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    g.checks.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: "Já existe outra conferência com este código.", path: ["checks", i, "id"] });
      ids.add(c.id);
    });
  });
export type GuardT = z.infer<typeof Guard>;
