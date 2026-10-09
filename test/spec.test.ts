import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/spec/agent.js";
import { buildSystemPrompt, contextBlock } from "../src/runtime/prompt.js";

const minimal = { persona: { name: "Clara", company: "Make Vendas" }, instructions: { goal: "Qualificar leads e agendar reunião." } };

describe("especificação do agente", () => {
  it("completa os padrões a partir do mínimo", () => {
    const r = parseSpec(minimal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.schema).toBe("mavi-agent/v1");
    expect(r.spec.buffer.seconds).toBe(8);
    expect(r.spec.knowledge.prefetch_k).toBe(6);
    expect(r.spec.output.max_messages).toBe(4);
    expect(r.spec.handoff.enabled).toBe(true);
  });

  it("recusa campo desconhecido e diz o caminho", () => {
    const r = parseSpec({ ...minimal, persona: { ...minimal.persona, nome: "x" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.path === "persona")).toBe(true);
  });

  it("exige objetivo", () => {
    const r = parseSpec({ persona: minimal.persona, instructions: { goal: " " } });
    expect(r.ok).toBe(false);
  });
});

describe("horário da semana", () => {
  it("aceita dias abertos e fechados e vai para o prompt", () => {
    const r = parseSpec({ ...minimal, instructions: { ...minimal.instructions, weekly_hours: { mon: { from: "09:00", to: "18:00" }, sun: null } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = buildSystemPrompt(r.spec);
    expect(p).toContain("- Segunda: 09:00 às 18:00");
    expect(p).toContain("- Domingo: fechado");
  });
  it("recusa horário invertido", () => {
    const r = parseSpec({ ...minimal, instructions: { ...minimal.instructions, weekly_hours: { mon: { from: "18:00", to: "09:00" } } } });
    expect(r.ok).toBe(false);
  });
});

describe("prompt", () => {
  it("núcleo estável não depende da hora", () => {
    const r = parseSpec(minimal);
    if (!r.ok) throw new Error("spec");
    const a = buildSystemPrompt(r.spec);
    expect(a).toContain("Você é Clara");
    expect(a).toContain("transferir_para_humano");
    expect(a).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(buildSystemPrompt(r.spec)).toBe(a);
  });

  it("bloco de contexto traz hora de Brasília, dados e trechos", () => {
    const b = contextBlock({
      now: new Date("2026-10-08T15:30:00Z"),
      contactName: "Ana",
      phone: "5511999999999",
      facts: { email: "ana@x.com" },
      summary: "Quer saber de preços.",
      retrieved: [{ ref: "K1", kind: "faq", title: "Preço", content: "A partir de R$ 99." }],
    });
    expect(b).toContain("quinta-feira, 08/10/2026, 12:30");
    expect(b).toContain("email: ana@x.com");
    expect(b).toContain("[K1] (pergunta e resposta) Preço: A partir de R$ 99.");
  });
});
