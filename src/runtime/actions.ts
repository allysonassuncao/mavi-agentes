import type { ActionDebug } from "../integrations/debug.js";
import type { ToolDef } from "../llm/client.js";
import { ACTION_TOOL_PREFIX, actionToolName, type ActionInputT, type ActionStep, type ActionT, type ConditionT, type OperandT, type WhenT } from "../spec/actions.js";
import type { AgentSpec } from "../spec/agent.js";

/**
 * Ações: o motor faz as contas e validações configuradas em blocos (aba Ações)
 * e devolve o texto do resultado ao agente. Tudo aqui é determinístico e sem
 * efeito fora da conversa: o agente não faz conta de cabeça.
 */

type Value = number | string | boolean;
type Env = Map<string, Value>;

export const isActionTool = (name: string) => name.startsWith(ACTION_TOOL_PREFIX);
const enabled = (spec: AgentSpec) => (spec.actions ?? []).filter((a) => a.enabled);
export const actionOf = (spec: AgentSpec, tool: string) => enabled(spec).find((a) => actionToolName(a.id) === tool);

// ---------------------------------------------------------------- ferramentas

const HINT: Record<ActionInputT["type"], string> = {
  text: "",
  number: "Só o número.",
  money: "Valor em reais, só o número (ex.: 68900).",
  integer: "Número inteiro.",
  boolean: "",
  date: "Data no formato DD/MM/AAAA.",
  cpf: "CPF com 11 dígitos.",
  cnpj: "CNPJ com 14 dígitos.",
  email: "E-mail.",
  phone: "Telefone com DDD.",
  choice: "",
};

export function actionTools(spec: AgentSpec): ToolDef[] {
  return enabled(spec).map((a) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const i of a.inputs) {
      if (i.source !== "agent") continue;
      const desc = [i.label, i.description, HINT[i.type]].filter(Boolean).join(". ");
      properties[i.id] =
        i.type === "number" || i.type === "money" || i.type === "integer"
          ? { type: "number", description: desc }
          : i.type === "boolean"
            ? { type: "boolean", description: desc }
            : i.type === "choice"
              ? { type: "string", enum: i.options, description: desc }
              : { type: "string", description: desc };
      if (i.required) required.push(i.id);
    }
    return {
      type: "function",
      function: {
        name: actionToolName(a.id),
        description: `${a.name}. Quando usar: ${a.when}\nO sistema faz a conta/validação: use o resultado como veio, nunca calcule de cabeça.`,
        parameters: { type: "object", properties, required },
      },
    } satisfies ToolDef;
  });
}

// ---------------------------------------------------------------- dados

const digits = (s: string) => s.replace(/\D/g, "");

export function validCpf(raw: string): boolean {
  const c = digits(raw);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(c[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

export function validCnpj(raw: string): boolean {
  const c = digits(raw);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (n: number) => {
    const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((s, x, i) => s + x * Number(c[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

/** "R$ 68.900,00", "68900", "68,9 mil" → número. */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const mil = /\bmil\b/.test(s);
  s = s.replace(/[^\d,.-]/g, "");
  if (!s) return null;
  // 68.900,50 → 68900.50; 68,900.50 → 68900.50; 68.900 → 68900; 68,9 → 68.9
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (mil ? n * 1000 : n) : null;
}

/** DD/MM/AAAA, AAAA-MM-DD ou DD-MM-AAAA → {iso, br} (data real). */
export function parseDate(raw: string): { iso: string; br: string; date: Date } | null {
  const s = raw.trim();
  let d: number, m: number, y: number;
  let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) {
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    if (y < 100) y += y > Number(String(new Date().getFullYear()).slice(2)) ? 1900 : 2000;
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return { iso: `${y}-${p(m)}-${p(d)}`, br: `${p(d)}/${p(m)}/${y}`, date };
}

const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

export function ageOn(birth: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const md = now.getUTCMonth() - birth.getUTCMonth();
  if (md < 0 || (md === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

const fold = (v: unknown) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

export type InputProblem = { id: string; label: string; problem: "missing" | "invalid"; why?: string };
export type ActionContact = { phone: string | null; contactName: string | null; facts: Record<string, unknown> };

/** Lê e valida os dados (do agente ou do contato). Os que faltam ou não valem vêm em `problems`. */
export function readInputs(action: ActionT, args: Record<string, unknown>, contact: ActionContact, now = new Date()): { env: Env; problems: InputProblem[] } {
  const env: Env = new Map();
  const problems: InputProblem[] = [];
  for (const i of action.inputs) {
    let raw: unknown =
      i.source === "contact" ? (i.value === "phone" ? contact.phone : i.value === "name" ? contact.contactName : contact.facts[i.value.slice(5)]) : args[i.id];
    if (typeof raw === "string") raw = raw.trim();
    if (raw === null || raw === undefined || raw === "") {
      if (i.required) problems.push({ id: i.id, label: i.label, problem: "missing" });
      continue;
    }
    const bad = (why: string) => problems.push({ id: i.id, label: i.label, problem: "invalid", why });
    const s = String(raw);
    switch (i.type) {
      case "number":
      case "money":
      case "integer": {
        const n = parseNumber(raw);
        if (n === null) bad("não é um número");
        else env.set(i.id, i.type === "integer" ? Math.round(n) : n);
        break;
      }
      case "boolean": {
        const t = fold(raw);
        if (typeof raw === "boolean") env.set(i.id, raw);
        else if (["true", "sim", "s", "1", "yes", "tem", "possui"].includes(t)) env.set(i.id, true);
        else if (["false", "nao", "n", "0", "no", "nao tem", "nao possui"].includes(t)) env.set(i.id, false);
        else bad("responda sim ou não");
        break;
      }
      case "date": {
        const d = parseDate(s);
        if (!d) bad("data inválida (use DD/MM/AAAA)");
        else {
          env.set(i.id, d.br);
          env.set(`${i.id}_idade`, ageOn(d.date, now));
          env.set(`${i.id}_dia_semana`, WEEKDAYS[d.date.getUTCDay()]!);
        }
        break;
      }
      case "cpf":
        if (!validCpf(s)) bad("CPF inválido (os dígitos não conferem)");
        else env.set(i.id, digits(s));
        break;
      case "cnpj":
        if (!validCnpj(s)) bad("CNPJ inválido (os dígitos não conferem)");
        else env.set(i.id, digits(s));
        break;
      case "email":
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) bad("e-mail inválido");
        else env.set(i.id, s.toLowerCase());
        break;
      case "phone": {
        const d = digits(s);
        if (d.length < 10 || d.length > 13) bad("telefone inválido (com DDD)");
        else env.set(i.id, d);
        break;
      }
      case "choice": {
        const hit = i.options.find((o) => fold(o) === fold(s));
        if (!hit) bad(`escolha entre: ${i.options.join(", ")}`);
        else env.set(i.id, hit);
        break;
      }
      default:
        env.set(i.id, s.slice(0, 2000));
    }
  }
  return { env, problems };
}

// ---------------------------------------------------------------- blocos

export class ActionError extends Error {}

function operand(o: OperandT | null, env: Env): Value | undefined {
  if (!o) return undefined;
  if ("number" in o) return o.number;
  if ("text" in o) return o.text;
  return env.get(o.var);
}

function asNumber(v: Value | undefined, what: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = parseNumber(v);
  if (n === null) throw new ActionError(`"${what}" não tem um número para a conta.`);
  return n;
}

const label = (o: OperandT | null) => (!o ? "" : "var" in o ? o.var : "number" in o ? String(o.number) : `"${o.text}"`);

function compare(c: ConditionT, env: Env): boolean {
  const a = operand(c.left, env);
  if (c.cmp === "empty") return a === undefined || a === "" || a === null;
  if (c.cmp === "filled") return !(a === undefined || a === "" || a === null);
  const b = operand(c.right, env);
  if (a === undefined || b === undefined) return false;
  if (c.cmp === "contains") return fold(a).includes(fold(b));
  if (c.cmp === "=" || c.cmp === "!=") {
    const na = typeof a === "number" || typeof b === "number" ? parseNumber(a) : null;
    const nb = na !== null ? parseNumber(b) : null;
    const eq = na !== null && nb !== null ? na === nb : typeof a === "boolean" || typeof b === "boolean" ? String(a) === String(b) : fold(a) === fold(b);
    return c.cmp === "=" ? eq : !eq;
  }
  const x = asNumber(a, label(c.left));
  const y = asNumber(b, label(c.right));
  return c.cmp === "<" ? x < y : c.cmp === "<=" ? x <= y : c.cmp === ">" ? x > y : x >= y;
}

const test = (w: WhenT, env: Env) => (w.mode === "all" ? w.rules.every((r) => compare(r, env)) : w.rules.some((r) => compare(r, env)));

const OP_LABEL = { "+": "+", "-": "−", "*": "×", "/": "÷", min: "menor entre", max: "maior entre" } as const;

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dec = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

export function formatValue(v: Value | undefined, format: string | null): string {
  if (v === undefined) return "";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "string" && format === null) return v;
  const n = typeof v === "number" ? v : parseNumber(v);
  if (n === null) return String(v);
  if (format === "dinheiro") return brl.format(n).replace(/ /g, " ");
  if (format === "inteiro") return int.format(n);
  if (format === "porcentagem") return `${dec.format(n)}%`;
  return dec.format(n);
}

export const fillTemplate = (t: string, env: Env) => t.replace(/\{([a-z][a-z0-9_]*)(?::([a-z]+))?\}/g, (_, name: string, f?: string) => formatValue(env.get(name), f ?? null));

type Run = { stopped: string | null; trace: string[] };

function runSteps(steps: ActionStep[], env: Env, run: Run, depth = 0): void {
  for (const s of steps) {
    if (run.stopped !== null) return;
    const pad = "  ".repeat(depth);
    if (s.kind === "set") {
      let acc = asNumber(operand(s.first, env), label(s.first));
      for (const t of s.terms) {
        const x = asNumber(operand(t.value, env), label(t.value));
        if (t.op === "/" && x === 0) throw new ActionError(`Divisão por zero em "${s.target}".`);
        acc = t.op === "+" ? acc + x : t.op === "-" ? acc - x : t.op === "*" ? acc * x : t.op === "/" ? acc / x : t.op === "min" ? Math.min(acc, x) : Math.max(acc, x);
      }
      if (s.round !== null) acc = Math.round(acc * 10 ** s.round) / 10 ** s.round;
      env.set(s.target, acc);
      run.trace.push(`${pad}${s.target} = ${[label(s.first), ...s.terms.map((t) => `${OP_LABEL[t.op]} ${label(t.value)}`)].join(" ")} → ${formatValue(acc, null)}`);
    } else if (s.kind === "text") {
      const v = fillTemplate(s.template, env);
      env.set(s.target, v);
      run.trace.push(`${pad}${s.target} = "${v.slice(0, 200)}"`);
    } else if (s.kind === "stop") {
      run.stopped = fillTemplate(s.message, env);
      run.trace.push(`${pad}parou: ${run.stopped.slice(0, 300)}`);
    } else {
      const ok = test(s.when, env);
      run.trace.push(`${pad}se ${s.when.rules.map((r) => `${label(r.left)} ${r.cmp} ${label(r.right)}`).join(s.when.mode === "all" ? " e " : " ou ")} → ${ok ? "sim" : "não"}`);
      runSteps(ok ? s.then : s.else, env, run, depth + 1);
    }
  }
}

export type ActionRun = {
  ok: boolean;
  /** missing/invalid: faltou ou não valeu um dado; stopped: um bloco "parar"; done: chegou ao fim. */
  status: "missing" | "invalid" | "stopped" | "done" | "error";
  message: string;
  values: Record<string, Value>;
  trace: string[];
  problems: InputProblem[];
  facts: Record<string, string>;
};

/** Roda a ação inteira (também é o "Testar" da aba Ações). */
export function runAction(action: ActionT, args: Record<string, unknown>, contact: ActionContact, now = new Date()): ActionRun {
  const { env, problems } = readInputs(action, args, contact, now);
  const values = () => Object.fromEntries(env);
  if (problems.length) {
    const invalid = problems.filter((p) => p.problem === "invalid");
    return {
      ok: false,
      status: invalid.length ? "invalid" : "missing",
      message: invalid.length ? invalid.map((p) => `${p.label}: ${p.why}`).join("; ") : `Faltam: ${problems.map((p) => p.label).join(", ")}`,
      values: values(),
      trace: [],
      problems,
      facts: {},
    };
  }
  const run: Run = { stopped: null, trace: [] };
  try {
    runSteps(action.steps, env, run);
  } catch (e) {
    return { ok: false, status: "error", message: e instanceof Error ? e.message : String(e), values: values(), trace: run.trace, problems: [], facts: {} };
  }
  if (run.stopped !== null) return { ok: true, status: "stopped", message: run.stopped, values: values(), trace: run.trace, problems: [], facts: {} };
  const message = action.result.message ? fillTemplate(action.result.message, env) : "Feito: os dados conferem.";
  const facts = Object.fromEntries(
    action.result.save_facts.filter((f) => env.has(f)).map((f) => [f, typeof env.get(f) === "number" ? formatValue(env.get(f), null) : String(env.get(f))]),
  );
  return { ok: true, status: "done", message, values: values(), trace: run.trace, problems: [], facts };
}

/** O que o agente recebe (e o rastro). */
export function runActionTool(spec: AgentSpec, name: string, args: Record<string, unknown>, contact: ActionContact): { result: string; debug: ActionDebug; facts: Record<string, string> } {
  const action = actionOf(spec, name);
  if (!action) return { result: "Ferramenta não disponível.", debug: { outcome: "error", code: "action_off", summary: "Ação desligada ou removida." }, facts: {} };
  const r = runAction(action, args, contact);
  const how = action.result.instructions ? `\nComo usar: ${action.result.instructions}` : "";
  if (r.status === "missing")
    return {
      result: `Faltam dados para "${action.name}": ${r.problems.map((p) => p.label).join(", ")}. Peça ao lead o que faltar, um por vez, e chame de novo.`,
      debug: { outcome: "empty", code: "action_missing", summary: r.message },
      facts: {},
    };
  if (r.status === "invalid")
    return {
      result: `Não deu para fazer "${action.name}": ${r.message}. Peça de novo ao lead, com naturalidade, só o dado que não valeu.`,
      debug: { outcome: "blocked", code: "action_invalid", summary: r.message },
      facts: {},
    };
  if (r.status === "error")
    return {
      result: `A ação "${action.name}" não conseguiu fazer a conta agora. Não invente valores: diga que vai confirmar e siga a conversa.`,
      debug: { outcome: "error", code: "action_error", summary: r.message, hint: "Abra a ação na aba Ações e use Testar com os mesmos dados." },
      facts: {},
    };
  const shown = Object.fromEntries(Object.entries(r.values).filter(([k]) => !action.inputs.some((i) => i.id === k && (i.type === "cpf" || i.type === "cnpj"))));
  return {
    result:
      (r.status === "stopped" ? `"${action.name}" parou: ${r.message}` : `Resultado de "${action.name}": ${r.message}`) +
      `${how}\nValores: ${JSON.stringify(shown).slice(0, 1500)}\nUse o resultado como veio; não refaça a conta.`,
    debug: { outcome: "ok", summary: r.message.slice(0, 500), details: r.trace.slice(0, 40) },
    facts: r.facts,
  };
}
