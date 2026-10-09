import { describe, expect, it } from "vitest";
import { costOf, parseModelRef } from "../src/llm/providers.js";
import { parseSpec } from "../src/spec/agent.js";
import { withModelDefaults } from "../src/api/routes/agents.js";

describe("referência do modelo", () => {
  it("provedor:modelo e o formato antigo", () => {
    expect(parseModelRef("openrouter:openai/gpt-5.2")).toEqual({ kind: "openrouter", model: "openai/gpt-5.2" });
    expect(parseModelRef("anthropic:claude-sonnet-4-6")).toEqual({ kind: "anthropic", model: "claude-sonnet-4-6" });
    expect(parseModelRef("openrouter:openai/gpt-oss-120b:free")).toEqual({ kind: "openrouter", model: "openai/gpt-oss-120b:free" });
    expect(parseModelRef("openai/gpt-5.2")).toEqual({ kind: "openrouter", model: "openai/gpt-5.2" });
    expect(parseModelRef("gpt-4.1")).toEqual({ kind: "openai", model: "gpt-4.1" });
  });

  it("custo pelo preço do Painel (cache mais barato)", () => {
    expect(costOf({ input: 3, output: 15, cached: 0.3 }, 1_000_000, 100_000, 400_000)).toBeCloseTo(0.6 * 3 + 0.4 * 0.3 + 0.1 * 15);
    expect(costOf(null, 1000, 1000, 0)).toBe(0);
  });
});

describe("publicar com o padrão do Painel", () => {
  const spec = (() => {
    const r = parseSpec({ persona: { name: "Clara", company: "X" }, instructions: { goal: "y" } });
    if (!r.ok) throw new Error("spec");
    return r.spec;
  })();

  it("modelo vazio recebe o padrão e o preço", () => {
    const s = withModelDefaults(spec, {
      default_model: "openrouter:openai/gpt-5.2",
      default_fallback: "openai:gpt-4.1",
      pricing: { "openrouter:openai/gpt-5.2": { input: 1.25, output: 10 }, "openai:gpt-4.1": { input: 2, output: 8 } },
    });
    expect(s.model).toMatchObject({
      model: "openrouter:openai/gpt-5.2",
      fallback_model: "openai:gpt-4.1",
      pricing: { input: 1.25, output: 10 },
      fallback_pricing: { input: 2, output: 8 },
    });
  });

  it("modelo escolhido continua o escolhido", () => {
    const s = withModelDefaults({ ...spec, model: { ...spec.model, model: "anthropic:claude-sonnet-4-6" } }, { default_model: "openrouter:x/y" });
    expect(s.model.model).toBe("anthropic:claude-sonnet-4-6");
  });
});
