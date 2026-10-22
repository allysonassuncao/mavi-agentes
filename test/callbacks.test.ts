import { describe, expect, it } from "vitest";
import {
  callbackLine,
  callbackTools,
  callbackVars,
  checkWhen,
  describeActions,
  parseWhen,
  planSchedule,
  runCallbackActions,
  validManualDue,
} from "../src/runtime/callbacks.js";
import { callbacksPrompt } from "../src/integrations/prompt.js";
import { buildSystemPrompt, contextBlock } from "../src/runtime/prompt.js";
import { parseSpec, type AgentSpec } from "../src/spec/agent.js";
import { CallbackActions } from "../src/spec/callbacks.js";
import type { IntegrationCtx } from "../src/integrations/index.js";

const base = { persona: { name: "Clara", company: "X" }, instructions: { goal: "y" } };
const spec = (callbacks: unknown): AgentSpec => {
  const r = parseSpec({ ...base, callbacks });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
};
const week = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { from: "09:00", to: "18:00" }]));
// Segunda 12/10/2026 às 10:00 em Brasília.
const now = new Date("2026-10-12T13:00:00Z");
const TYPE = "7b7e3c1e-1111-4111-8111-111111111111";

describe("retornos combinados", () => {
  it("a configuração: padrões e a equipe precisa de atividade ou aviso", () => {
    const s = spec({});
    expect(s.callbacks).toMatchObject({ enabled: true, contact: "agent", max_days: 180, when_ai_off: "skip", followup: { during: "pause", after: "restart" } });
    expect(s.callbacks!.on_create.activity).toBeNull();
    expect(s.callbacks!.postponed).toMatchObject({ enabled: false, from: 2 });
    expect(parseSpec({ ...base }).ok).toBe(true);
    expect(parseSpec({ ...base, callbacks: { contact: "team" } }).ok).toBe(false);
    expect(parseSpec({ ...base, callbacks: { contact: "team", on_due: { notify_team: true } } }).ok).toBe(true);
    expect(parseSpec({ ...base, callbacks: { contact: "both", on_due: { activity: { type_id: TYPE, subject: "Ligar para o lead" } } } }).ok).toBe(true);
    expect(parseSpec({ ...base, callbacks: { postponed: { enabled: true, from: 1 } } }).ok).toBe(false);
    expect(parseSpec({ ...base, callbacks: { max_days: 0 } }).ok).toBe(false);
  });

  it("lê a data e a hora (Brasília sem fuso)", () => {
    expect(parseWhen("2026-10-28 10:00")!.toISOString()).toBe("2026-10-28T13:00:00.000Z");
    expect(parseWhen("2026-10-28T9:30")!.toISOString()).toBe("2026-10-28T12:30:00.000Z");
    expect(parseWhen("2026-10-28T10:00:00-03:00")!.toISOString()).toBe("2026-10-28T13:00:00.000Z");
    expect(parseWhen("2026-10-28T13:00:00Z")!.toISOString()).toBe("2026-10-28T13:00:00.000Z");
    expect(parseWhen("2026-10-28T10:00:00.000")!.toISOString()).toBe("2026-10-28T13:00:00.000Z");
    expect(parseWhen("2026-10-28T10:00:00.000+0000")!.toISOString()).toBe("2026-10-28T10:00:00.000Z");
    expect(parseWhen("28/10 10h")).toBeNull();
    expect(parseWhen("2026-02-30 10:00")).toBeNull();
    expect(parseWhen("2026-10-28 25:00")).toBeNull();
  });

  it("confere a data: futuro, limite de dias e a janela só quando o agente escolheu", () => {
    const opts = { window: week, maxDays: 30 };
    expect(checkWhen(new Date("2026-10-12T13:02:00Z"), { ...opts, chosenBy: "lead" }, now)).toEqual({ ok: false, reason: "O retorno precisa ser pelo menos 5 minutos no futuro." });
    expect(checkWhen(new Date("2026-12-12T13:00:00Z"), { ...opts, chosenBy: "lead" }, now).ok).toBe(false);
    // Sábado 17/10 às 10:00: o lead pediu, vale como está.
    const sat = new Date("2026-10-17T13:00:00Z");
    expect(checkWhen(sat, { ...opts, chosenBy: "lead" }, now)).toEqual({ ok: true, due: sat, adjusted: false });
    // O agente escolheu: vai para segunda 19/10 às 09:00.
    expect(checkWhen(sat, { ...opts, chosenBy: "agente" }, now)).toEqual({ ok: true, due: new Date("2026-10-19T12:00:00Z"), adjusted: true });
    // Terça 20h pelo agente → quarta 09:00.
    const r = checkWhen(new Date("2026-10-13T23:00:00Z"), { ...opts, chosenBy: "agente" }, now);
    expect(r.ok && r.due.toISOString()).toBe("2026-10-14T12:00:00.000Z");
    // Sem janela: como pedido.
    expect(checkWhen(sat, { window: null, maxDays: 30, chosenBy: "agente" }, now)).toEqual({ ok: true, due: sat, adjusted: false });
  });

  it("remarcar: o mesmo horário mantém, a sugestão se ajusta e o combinado conta como adiamento", () => {
    const due = new Date("2026-10-20T13:00:00Z");
    expect(planSchedule(null, due)).toBe("new");
    expect(planSchedule({ due_at: new Date("2026-10-20T13:00:30Z"), agreed: "confirmed" }, due)).toBe("same");
    expect(planSchedule({ due_at: new Date("2026-10-19T13:00:00Z"), agreed: "suggested" }, due)).toBe("adjust");
    expect(planSchedule({ due_at: new Date("2026-10-19T13:00:00Z"), agreed: "confirmed" }, due)).toBe("postpone");
  });

  it("as ferramentas e o prompt só com os retornos ligados", () => {
    expect(callbackTools(spec(null)).length).toBe(0);
    expect(callbackTools(spec({ enabled: false })).length).toBe(0);
    const s = spec({ when: "quando disser que vai falar com o sócio" });
    expect(callbackTools(s).map((t) => t.function.name)).toEqual(["agendar_retorno", "cancelar_retorno"]);
    const p = callbacksPrompt(s);
    expect(p).toContain("# Retornos combinados");
    expect(p).toContain("proponha um dia e uma hora concretos");
    expect(p).toContain("Marque retorno também: quando disser que vai falar com o sócio");
    expect(buildSystemPrompt(s)).toContain("# Retornos combinados");
    expect(buildSystemPrompt(spec(null))).not.toContain("Retornos combinados");
  });

  it("o contexto diz o retorno marcado", () => {
    const line = callbackLine({ due_at: new Date("2026-10-20T13:00:00Z"), agreed: "suggested", request: "pediu para chamar na semana que vem", topic: "proposta anual" });
    expect(line).toBe("terça-feira, 20/10 às 10:00 (você sugeriu e o lead ainda não confirmou); pedido: pediu para chamar na semana que vem; retomar: proposta anual");
    expect(contextBlock({ facts: {}, summary: "", retrieved: [], callback: line })).toContain(`Retorno combinado com este lead: ${line}`);
  });

  it("as ações: o que fariam e a simulação não mexe no CRM", async () => {
    const a = CallbackActions.parse({ activity: { type_id: TYPE, subject: "Ligar" }, note: true, notify_team: true, turn_off_ai: true });
    expect(describeActions(a)).toEqual(["criar a atividade \"Ligar\"", "registrar no histórico da oportunidade", "avisar a equipe", "desligar a MAVI nesta conversa"]);
    expect(describeActions(CallbackActions.parse({}))).toEqual([]);
    const ctx = { simulation: true, spec: spec({}) } as unknown as IntegrationCtx;
    const r = await runCallbackActions(ctx, a, { moment: "on_create", cb: { id: "x", due_at: now, request: "", topic: "" }, deferTurnOff: true });
    expect(r.turnOffAi).toBe(false);
    expect(r.done[0]).toBe("criar a atividade \"Ligar\" (simulação)");
    expect((await runCallbackActions(ctx, CallbackActions.parse({}), { moment: "on_due", cb: { id: "x", due_at: now, request: "", topic: "" } })).done).toEqual([]);
  });

  it("as variáveis do modelo aprovado e a data marcada à mão", () => {
    expect(callbackVars({ contactName: "Ana Souza", agent: "Clara", company: "X", due: new Date("2026-10-20T13:00:00Z") })).toEqual({
      nome: "Ana Souza",
      primeiro_nome: "Ana",
      agente: "Clara",
      empresa: "X",
      data: "20/10",
      hora: "10:00",
      dia_semana: "terça-feira",
    });
    expect(validManualDue(new Date("2026-10-12T13:00:30Z"), 30, now)).toBe("Escolha uma data e hora no futuro.");
    expect(validManualDue(new Date("2026-12-12T13:00:00Z"), 30, now)).toBe("O retorno pode ser marcado até 30 dias à frente.");
    expect(validManualDue(new Date("2026-10-13T13:00:00Z"), 30, now)).toBeNull();
  });
});
