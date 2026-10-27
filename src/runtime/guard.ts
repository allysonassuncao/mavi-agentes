import type { AgentSpec } from "../spec/agent.js";
import { patternRegex, type GuardCheckT } from "../spec/guard.js";
import type { ReplyMessage } from "./output.js";

/**
 * Conferência da resposta (aba Conferência): regras em código, sem IA, antes
 * de a resposta sair. Puro: o motor (turn.ts) decide o que fazer com o
 * resultado (reescrever, mandar a mensagem de segurança ou enviar assim).
 */

const fold = (v: string) =>
  v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Onde cada padrão bateu (trechos), na ordem; [] = não bateu. */
export function patternHits(pattern: string, text: string): RegExpMatchArray[] {
  const re = patternRegex(pattern);
  if (re) return [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))];
  const f = fold(text);
  const p = fold(pattern);
  const out: RegExpMatchArray[] = [];
  let i = f.indexOf(p);
  while (i >= 0 && out.length < 20) {
    const m = [text.slice(i, i + p.length)] as unknown as RegExpMatchArray;
    m.index = i;
    out.push(m);
    i = f.indexOf(p, i + Math.max(1, p.length));
  }
  return out;
}

/** "R$ 68.900,00" → 68900; "1.182" → 1182. Os números de um texto, como inteiros (sem centavos). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?/g)) out.push(Number(m[1]!.replace(/\./g, "")));
  return out;
}

export type GuardTool = { name: string; ok: boolean; result: string };
export type GuardContext = {
  stageId: string | null;
  /** Ferramentas que rodaram nesta vez (ok = deu certo). */
  tools: GuardTool[];
  facts: Record<string, unknown>;
  /** Textos de onde números podem vir: conversa, mensagens do lead desta vez, conhecimento encontrado. */
  sources: string;
};
export type GuardViolation = { id: string; name: string; severity: "grave" | "leve"; message: string; excerpt?: string };

const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";

function applies(c: GuardCheckT, stageId: string | null): boolean {
  if (!c.enabled) return false;
  if (c.stages.length && (!stageId || !c.stages.includes(stageId))) return false;
  if (stageId && c.skip_stages.includes(stageId)) return false;
  return true;
}

export function checkReply(spec: AgentSpec, reply: ReplyMessage[], ctx: GuardContext): GuardViolation[] {
  if (!spec.guard.enabled) return [];
  const texts = reply.map((m) => m.text).filter((t) => t.trim());
  const all = texts.join("\n");
  if (!all.trim()) return [];
  const out: GuardViolation[] = [];
  const add = (c: GuardCheckT, excerpt?: string) => out.push({ id: c.id, name: c.name, severity: c.severity, message: c.message, ...(excerpt ? { excerpt: excerpt.slice(0, 160) } : {}) });
  let sourceNumbers: Set<number> | null = null;

  for (const c of spec.guard.checks) {
    if (!applies(c, ctx.stageId)) continue;
    switch (c.kind) {
      case "forbidden": {
        for (const p of c.patterns) {
          const h = patternHits(p, all)[0];
          if (h) {
            add(c, h[0]);
            break;
          }
        }
        break;
      }
      case "requires": {
        const hit = c.patterns.map((p) => patternHits(p, all)[0]).find(Boolean);
        if (!hit) break;
        const byTool = ctx.tools.some((t) => t.ok && c.tools.includes(t.name));
        const byFact = c.facts.some((f) => filled(ctx.facts[f]));
        if (!byTool && !byFact) add(c, hit[0]);
        break;
      }
      case "number_source": {
        sourceNumbers ??= new Set(numbersIn(`${ctx.sources}\n${ctx.tools.map((t) => t.result).join("\n")}\n${Object.values(ctx.facts).map(String).join("\n")}`));
        let bad: string | null = null;
        for (const p of c.patterns) {
          for (const h of patternHits(p, all)) {
            const piece = h[1] ?? h[0];
            const ns = numbersIn(piece);
            if (ns.some((n) => !sourceNumbers!.has(n))) {
              bad = h[0];
              break;
            }
          }
          if (bad) break;
        }
        if (bad) add(c, bad);
        break;
      }
      case "max_questions": {
        const n = (all.match(/\?/g) ?? []).length;
        if (n > c.max) add(c, `${n} perguntas`);
        break;
      }
      case "question_last": {
        if (!all.includes("?")) break;
        const last = texts[texts.length - 1] ?? "";
        // Depois da interrogação só pode vir emoji ou espaço.
        if (!/\?[\s\p{Extended_Pictographic}‍️]*$/u.test(last)) add(c, last.slice(-80));
        break;
      }
    }
  }
  return out;
}

/** O que o agente recebe quando a resposta é barrada (resultado da ferramenta responder). */
export function correctionNote(violations: GuardViolation[], reply: ReplyMessage[], effects: string[]): string {
  const items = violations.map((v) => `- ${v.message}${v.excerpt ? ` (trecho: "${v.excerpt}")` : ""}`).join("\n");
  const sent = reply.map((m) => m.text).join("\n").slice(0, 3000);
  return (
    "RESPOSTA BLOQUEADA pela conferência antes de chegar ao lead (ele não recebeu nada). Motivos:\n" +
    `${items}\n\nResposta bloqueada:\n<bloqueada>\n${sent}\n</bloqueada>\n` +
    (effects.length ? `\nFerramentas com efeito que já rodaram nesta vez (não chame de novo; use o retorno que veio): ${effects.join(", ")}.\n` : "") +
    "\nEscreva a resposta de novo, corrigindo os pontos acima e seguindo todas as regras, e chame responder."
  );
}
