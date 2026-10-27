import { describe, expect, it } from "vitest";
import { parseSpec } from "../src/spec/agent.js";
import { withModelDefaults, withModelOverride } from "../src/api/routes/agents.js";

const base = () => {
  const r = parseSpec({ persona: { name: "Clara", company: "Make Vendas" }, instructions: { goal: "Qualificar." }, model: { model: "openai:gpt-5-mini" } });
  if (!r.ok) throw new Error("spec");
  return r.spec;
};

describe("outro modelo só no teste", () => {
  it("troca o modelo do agente e usa o preço de quem constrói", () => {
    const s = withModelOverride(base(), "openrouter:anthropic/claude-sonnet-5.5", { "openrouter:anthropic/claude-sonnet-5.5": { input: 2, output: 10, cached: null } });
    expect(s.model.model).toBe("openrouter:anthropic/claude-sonnet-5.5");
    expect(s.model.pricing).toEqual({ input: 2, output: 10, cached: null });
  });
  it("sem a troca, fica o modelo do agente", () => {
    const s = withModelOverride(withModelDefaults(base(), { default_model: "openai:gpt-6" }), undefined);
    expect(s.model.model).toBe("openai:gpt-5-mini");
  });
  it("vence o padrão do Painel", () => {
    const r = parseSpec({ persona: { name: "Clara", company: "Make Vendas" }, instructions: { goal: "Qualificar." } });
    if (!r.ok) throw new Error("spec");
    const s = withModelOverride(withModelDefaults(r.spec, { default_model: "openai:gpt-6" }), "openrouter:x/y");
    expect(s.model.model).toBe("openrouter:x/y");
    expect(s.model.pricing).toBeNull();
  });
});
