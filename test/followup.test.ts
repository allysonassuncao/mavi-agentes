import { describe, expect, it } from "vitest";
import { nextOpening } from "../src/runtime/followup.js";
import { parseSpec } from "../src/spec/agent.js";
import { templateBody } from "../src/makecrm/client.js";

describe("régua de follow-up", () => {
  const base = { persona: { name: "Clara", company: "X" }, instructions: { goal: "y" } };

  it("valida as etapas", () => {
    const ok = parseSpec({
      ...base,
      followup: {
        steps: [
          { id: "e1", after_minutes: 60, mode: "ai", text: "retome a proposta" },
          { id: "e2", after_minutes: 1440, mode: "fixed", text: "Oi {primeiro_nome}, conseguiu ver?", template: { template_id: "123", params: ["{nome}"] } },
        ],
        on_finish: { move: null, notify: "Lead {nome} não respondeu", turn_off_ai: true },
      },
    });
    expect(ok.ok).toBe(true);
    expect(parseSpec({ ...base, followup: { steps: [{ id: "e1", after_minutes: 60, mode: "fixed", text: "" }] } }).ok).toBe(false);
    expect(parseSpec({ ...base, followup: { steps: [{ id: "e1", after_minutes: 1 }] } }).ok).toBe(false);
    expect(parseSpec({ ...base, followup: { steps: [] } }).ok).toBe(false);
  });

  it("espera a janela de envio abrir", () => {
    const win = { mon: { from: "09:00", to: "18:00" }, tue: { from: "09:00", to: "18:00" } };
    // Segunda 12/10/2026 07:00 em Brasília → segunda 09:00.
    expect(nextOpening(win, new Date("2026-10-12T10:00:00Z")).toISOString()).toBe("2026-10-12T12:00:00.000Z");
    // Segunda 10:00 → agora.
    const now = new Date("2026-10-12T13:00:00Z");
    expect(nextOpening(win, now)).toBe(now);
    // Segunda 19:00 → terça 09:00.
    expect(nextOpening(win, new Date("2026-10-12T22:00:00Z")).toISOString()).toBe("2026-10-13T12:00:00.000Z");
    // Sem janela: agora.
    expect(nextOpening(null, now)).toBe(now);
  });

  it("lê o corpo e os exemplos do modelo aprovado", () => {
    const b = templateBody({
      template_config: {
        name: "retomada",
        language: "pt_BR",
        components: [{ type: "BODY", text: "Oi {{1}}, tudo bem? Ainda tem interesse em {{2}}?", example: { body_text: [["Ana", "consórcio"]] } }],
      },
    });
    expect(b).toEqual({ text: "Oi {{1}}, tudo bem? Ainda tem interesse em {{2}}?", examples: ["Ana", "consórcio"], language: "pt_BR", name: "retomada" });
  });
});
