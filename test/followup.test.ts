import { describe, expect, it } from "vitest";
import { nextOpening } from "../src/runtime/followup.js";
import { parseSpec } from "../src/spec/agent.js";
import { templateBody } from "../src/makecrm/client.js";
import { Followup } from "../src/spec/followup.js";

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

describe("follow-up por funil e etapa", () => {
  const P = "35eac71d-fc2f-48ab-b55f-819a21940b1a";
  const NOVOS = "1d3fa199-1627-45b3-9c06-c4973f2c9e45";
  const CONECTADO = "4df79316-fe35-4175-b6dd-2edbaf3fa980";
  const AGENDADO = "98bb245f-663d-4166-987c-56f02bf688e0";
  const base = { steps: [{ id: "a", after_minutes: 30 }, { id: "b", after_minutes: 120 }] };

  it("sem etapas: a régua padrão para todos", async () => {
    const { pickTrack } = await import("../src/runtime/followup-track.js");
    const fu = Followup.parse(base);
    expect(fu.stages).toEqual([]);
    expect(pickTrack(fu, [{ pipeline_id: P, stage_id: AGENDADO }])?.key).toBe("default");
  });

  it("com etapas: fora delas não recebe; sem oportunidade, a padrão; etapa com régua própria", async () => {
    const { pickTrack, trackSteps } = await import("../src/runtime/followup-track.js");
    const fu = Followup.parse({ ...base, stages: [{ pipeline_id: P, stage_id: NOVOS, steps: [{ id: "n1", after_minutes: 10 }] }, { pipeline_id: P, stage_id: CONECTADO }] });
    expect(pickTrack(fu, [{ pipeline_id: P, stage_id: AGENDADO }])).toBeNull();
    expect(pickTrack(fu, [])?.key).toBe("default");
    expect(pickTrack(fu, [{ pipeline_id: P, stage_id: CONECTADO }])).toEqual({ key: "default", steps: fu.steps });
    const novos = pickTrack(fu, [{ pipeline_id: P, stage_id: AGENDADO }, { pipeline_id: P, stage_id: NOVOS }]);
    expect(novos?.key).toBe(NOVOS);
    expect(novos?.steps.map((s) => s.id)).toEqual(["n1"]);
    expect(trackSteps(fu, NOVOS).map((s) => s.id)).toEqual(["n1"]);
    expect(trackSteps(fu, "etapa-que-saiu").map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("a mesma etapa duas vezes não vale", () => {
    expect(Followup.safeParse({ ...base, stages: [{ pipeline_id: P, stage_id: NOVOS }, { pipeline_id: P, stage_id: NOVOS }] }).success).toBe(false);
  });
});
