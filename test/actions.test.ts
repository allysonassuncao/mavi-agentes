import { describe, expect, it } from "vitest";
import { actionTools, fillTemplate, parseDate, parseNumber, runAction, runActionTool, validCnpj, validCpf } from "../src/runtime/actions.js";
import { parseSpec } from "../src/spec/agent.js";
import { Action } from "../src/spec/actions.js";

const v = (name: string) => ({ var: name });
const n = (number: number) => ({ number });

/** A simulação da Luiza (Estoque Car): entrada mínima, ajuste do valor e as parcelas. */
const simulacao = {
  id: "simulacao",
  name: "Simulação de parcelas",
  when: "Depois de ter o valor do veículo e a entrada",
  inputs: [
    { id: "valor_veiculo", label: "Valor do veículo", type: "money" },
    { id: "valor_entrada", label: "Entrada", type: "money" },
    { id: "cpf", label: "CPF", type: "cpf" },
    { id: "nascimento", label: "Nascimento", type: "date" },
  ],
  steps: [
    {
      id: "minima",
      kind: "if",
      when: { rules: [{ left: v("valor_entrada"), cmp: "<", right: n(5000) }] },
      then: [{ id: "parar", kind: "stop", message: "A entrada mínima é de {minimo:dinheiro}." }],
      else: [],
    },
    {
      id: "ajuste",
      kind: "if",
      when: { rules: [{ left: v("valor_veiculo"), cmp: "<=", right: n(80000) }] },
      then: [{ id: "soma", kind: "set", target: "valor_ajustado", first: v("valor_veiculo"), terms: [{ op: "+", value: n(5000) }] }],
      else: [{ id: "desconta", kind: "set", target: "valor_ajustado", first: v("valor_veiculo"), terms: [{ op: "-", value: n(5000) }] }],
    },
    { id: "saldo", kind: "set", target: "saldo", first: v("valor_ajustado"), terms: [{ op: "-", value: v("valor_entrada") }] },
    { id: "p60", kind: "set", target: "parcela_60x", first: v("saldo"), terms: [{ op: "/", value: n(60) }] },
    { id: "p48", kind: "set", target: "parcela_48x", first: v("saldo"), terms: [{ op: "/", value: n(48) }] },
  ],
  result: { message: "Entrada de {valor_entrada:dinheiro} em 60x de {parcela_60x:dinheiro} ou 48x de {parcela_48x:dinheiro}.", save_facts: ["cpf"] },
};

const contact = { phone: null, contactName: null, facts: {} };

describe("especificação das ações", () => {
  it("bloco que usa o que ainda não existe", () => {
    const r = Action.safeParse(simulacao);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message).join(" ")).toContain("{minimo}");
  });

  it("aceita a simulação e vira ferramenta só com os dados do agente", () => {
    const ok = { ...simulacao, steps: [{ id: "min", kind: "set", target: "minimo", first: n(5000), terms: [] }, ...simulacao.steps] };
    const r = parseSpec({ persona: { name: "Luiza", company: "Estoque Car" }, instructions: { goal: "Vender" }, actions: [ok] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [tool] = actionTools(r.spec);
    expect(tool!.function.name).toBe("acao_simulacao");
    expect(Object.keys((tool!.function.parameters as { properties: object }).properties)).toEqual(["valor_veiculo", "valor_entrada", "cpf", "nascimento"]);
  });

  it("nomes repetidos e conta por cima de um dado", () => {
    const r = Action.safeParse({ ...simulacao, steps: [{ id: "x", kind: "set", target: "valor_entrada", first: n(1), terms: [] }] });
    expect(r.success).toBe(false);
  });
});

describe("rodar a ação", () => {
  const ok = Action.parse({ ...simulacao, steps: [{ id: "min", kind: "set", target: "minimo", first: n(5000), terms: [] }, ...simulacao.steps] });

  it("calcula como o n8n (até 80 mil soma 5 mil)", () => {
    const r = runAction(ok, { valor_veiculo: "R$ 68.900,00", valor_entrada: "10 mil", cpf: "529.982.247-25", nascimento: "07/01/1990" }, contact, new Date("2026-10-26T12:00:00Z"));
    expect(r.status).toBe("done");
    expect(r.values.valor_ajustado).toBe(73900);
    expect(r.values.parcela_60x).toBe(1065);
    expect(r.values.nascimento_idade).toBe(36);
    expect(r.values.nascimento_dia_semana).toBe("domingo");
    expect(r.message).toBe("Entrada de R$ 10.000,00 em 60x de R$ 1.065,00 ou 48x de R$ 1.331,25.");
    expect(r.facts).toEqual({ cpf: "52998224725" });
  });

  it("acima de 80 mil desconta; entrada baixa para no bloco", () => {
    expect(runAction(ok, { valor_veiculo: 100000, valor_entrada: 20000, cpf: "52998224725", nascimento: "1990-01-07" }, contact).values.valor_ajustado).toBe(95000);
    const stop = runAction(ok, { valor_veiculo: 50000, valor_entrada: 1000, cpf: "52998224725", nascimento: "07/01/1990" }, contact);
    expect(stop.status).toBe("stopped");
    expect(stop.message).toBe("A entrada mínima é de R$ 5.000,00.");
  });

  it("CPF e data inválidos pedem de novo; faltando, pede o que falta", () => {
    const bad = runAction(ok, { valor_veiculo: 1, valor_entrada: 6000, cpf: "111.111.111-11", nascimento: "31/02/1990" }, contact);
    expect(bad.status).toBe("invalid");
    expect(bad.problems.map((p) => p.id)).toEqual(["cpf", "nascimento"]);
    const miss = runAction(ok, { valor_veiculo: 1 }, contact);
    expect(miss.status).toBe("missing");
  });

  it("o agente recebe o resultado sem o CPF e os fatos para guardar", () => {
    const spec = parseSpec({ persona: { name: "Luiza", company: "Estoque Car" }, instructions: { goal: "Vender" }, actions: [ok] });
    if (!spec.ok) throw new Error("spec");
    const r = runActionTool(spec.spec, "acao_simulacao", { valor_veiculo: 68900, valor_entrada: 10000, cpf: "52998224725", nascimento: "07/01/1990" }, contact);
    expect(r.result).toContain("60x de R$ 1.065,00");
    expect(r.result).not.toContain("52998224725");
    expect(r.facts.cpf).toBe("52998224725");
  });
});

describe("dados", () => {
  it("números do jeito que o lead escreve", () => {
    expect(parseNumber("R$ 68.900,00")).toBe(68900);
    expect(parseNumber("68.900")).toBe(68900);
    expect(parseNumber("68,9 mil")).toBe(68900);
    expect(parseNumber("1.234.567")).toBe(1234567);
    expect(parseNumber("12.5")).toBe(12.5);
    expect(parseNumber("abc")).toBeNull();
  });
  it("CPF, CNPJ e datas", () => {
    expect(validCpf("529.982.247-25")).toBe(true);
    expect(validCpf("529.982.247-24")).toBe(false);
    expect(validCnpj("11.222.333/0001-81")).toBe(true);
    expect(validCnpj("11.222.333/0001-82")).toBe(false);
    expect(parseDate("7/1/90")?.br).toBe("07/01/1990");
    expect(parseDate("2024-02-30")).toBeNull();
  });
  it("texto com formatos", () => {
    expect(fillTemplate("{a:dinheiro} | {a:inteiro} | {b} | {c}", new Map<string, number | string | boolean>([["a", 1065.5], ["b", "x"], ["c", true]]))).toBe("R$ 1.065,50 | 1.066 | x | sim");
  });
});
