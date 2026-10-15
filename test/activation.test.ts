import { describe, expect, it } from "vitest";
import { foldText, matchActivation } from "../src/runtime/activation.js";
import { parseSpec } from "../src/spec/agent.js";

const minimal = { persona: { name: "Clara", company: "Make Vendas" }, instructions: { goal: "Qualificar leads." } };

describe("ativação por gatilho: especificação", () => {
  it("vem desligada por padrão", () => {
    const r = parseSpec(minimal);
    expect(r.ok && r.spec.activation).toEqual({ enabled: false, terms: [] });
  });

  it("ligada exige ao menos um termo, no caminho dos termos", () => {
    const r = parseSpec({ ...minimal, activation: { enabled: true } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContainEqual(expect.objectContaining({ path: "activation.terms" }));
  });

  it("completa a comparação com 'contém' e recusa campo desconhecido", () => {
    const r = parseSpec({ ...minimal, activation: { enabled: true, terms: [{ term: " Promoção " }] } });
    expect(r.ok && r.spec.activation.terms).toEqual([{ term: "Promoção", match: "contains" }]);
    expect(parseSpec({ ...minimal, activation: { enabled: true, terms: [{ term: "x", modo: "exact" }] } }).ok).toBe(false);
  });
});

describe("ativação por gatilho: comparação", () => {
  const terms = [
    { term: "Promoção", match: "contains" as const },
    { term: "#VIP", match: "exact" as const },
  ];

  it("ignora maiúsculas, acentos e espaços", () => {
    expect(foldText("  PROMOÇÃO   de  Natal ")).toBe("promocao de natal");
    expect(matchActivation(terms, "Oi, vi a promocao no Instagram")).toBe("Promoção");
  });

  it("exato só aceita a mensagem com o termo (pontuação nas pontas não conta)", () => {
    expect(matchActivation(terms, "#vip")).toBe("#VIP");
    expect(matchActivation(terms, "vip!")).toBe("#VIP");
    expect(matchActivation(terms, "quero o vip")).toBeNull();
  });

  it("sem termo na mensagem, não ativa", () => {
    expect(matchActivation(terms, "Bom dia")).toBeNull();
    expect(matchActivation(terms, "")).toBeNull();
  });
});
