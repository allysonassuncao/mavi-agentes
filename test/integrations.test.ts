import { describe, expect, it } from "vitest";
import { freeSlots, parseWhen, spreadSlots, withinAllowed } from "../src/integrations/calendar.js";
import { spLabel } from "../src/integrations/time.js";
import { integrationTools } from "../src/integrations/index.js";
import { integrationsPrompt } from "../src/integrations/prompt.js";
import { parseSpec } from "../src/spec/agent.js";

const week = { mon: { from: "09:00", to: "12:00" }, tue: { from: "09:00", to: "12:00" }, wed: null, sat: null, sun: null };
const cfg = { allowed_hours: week, duration_minutes: 30, min_notice_minutes: 60, slot_step_minutes: 30 as const };

describe("horários livres", () => {
  // Terça, 13/10/2026, 08:00 em Brasília.
  const now = new Date("2026-10-13T11:00:00Z");

  it("respeita janela, antecedência, passo e eventos", () => {
    const busy = [{ start: Date.parse("2026-10-13T13:00:00Z"), end: Date.parse("2026-10-13T14:00:00Z") }]; // 10h-11h
    const s = freeSlots(cfg, busy, "2026-10-13", 2, now).map((x) => spLabel(x.start));
    // Conferências diretas (13/10/2026 é uma terça-feira).
    expect(s[0]).toBe("terça-feira, 13/10 às 09:00");
    expect(s).not.toContain("terça-feira, 13/10 às 10:00");
    expect(s).not.toContain("terça-feira, 13/10 às 10:30");
    expect(s).toContain("terça-feira, 13/10 às 11:30");
    expect(s.some((x) => x.startsWith("quarta"))).toBe(false); // quarta fechada
  });

  it("antecedência mínima corta o começo e arredonda para o passo", () => {
    const at = new Date("2026-10-13T12:07:00Z"); // 09:07
    const s = freeSlots(cfg, [], "2026-10-13", 1, at).map((x) => spLabel(x.start));
    expect(s[0]).toBe("terça-feira, 13/10 às 10:30"); // 09:07 + 60 min = 10:07 → 10:30
  });

  it("espalha no máximo 3 por dia e filtra o período", () => {
    const s = freeSlots({ ...cfg, allowed_hours: { tue: { from: "08:00", to: "20:00" } } }, [], "2026-10-13", 1, new Date("2026-10-12T12:00:00Z"));
    expect(spreadSlots(s, 6, null)).toHaveLength(3);
    expect(spreadSlots(s, 6, "tarde").every((x) => x.start.getUTCHours() - 3 >= 12 && x.start.getUTCHours() - 3 < 18)).toBe(true);
  });

  it("horário pedido em Brasília e dentro da janela", () => {
    const d = parseWhen("2026-10-13 10:00")!;
    expect(d.toISOString()).toBe("2026-10-13T13:00:00.000Z");
    expect(withinAllowed(cfg, d, new Date(d.getTime() + 30 * 60_000))).toBe(true);
    expect(withinAllowed(cfg, parseWhen("2026-10-14 10:00")!, parseWhen("2026-10-14 10:30")!)).toBe(false);
    expect(parseWhen("amanhã")).toBeNull();
  });
});

describe("integrações na especificação", () => {
  const base = { persona: { name: "Clara", company: "X" }, instructions: { goal: "y" } };
  const uid = "00000000-0000-4000-8000-000000000001";
  const integrations = [
    { type: "google_calendar", hosts: [{ user_id: uid }], allowed_hours: week },
    { type: "makecrm_move_deal", rules: [{ id: "qualificado", when: "quando o lead informar orçamento", pipeline_id: uid, stage_id: uid }] },
    { type: "makecrm_change_owner", rules: [{ id: "vendedor", when: "quando pedir proposta", owner: { mode: "round_robin", users: [{ user_id: uid, weight: 2 }] } }] },
    { type: "team_notify", inbox_id: uid, phones: ["5511999999999"], when: "quando o lead reclamar" },
  ];

  it("valida e gera as ferramentas e o prompt", () => {
    const r = parseSpec({ ...base, integrations });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const names = integrationTools(r.spec).map((t) => t.function.name);
    expect(names).toEqual(["agenda_horarios_livres", "agenda_marcar", "agenda_remarcar", "agenda_cancelar", "mover_oportunidade", "trocar_responsavel", "avisar_equipe"]);
    const mv = integrationTools(r.spec).find((t) => t.function.name === "mover_oportunidade")!;
    expect(mv.function.description).toContain("qualificado: quando o lead informar orçamento");
    expect(integrationsPrompt(r.spec)).toContain("agenda_horarios_livres");
  });

  it("recusa regra de responsável sem papel e telefone mal formatado", () => {
    expect(parseSpec({ ...base, integrations: [{ type: "makecrm_change_owner", rules: [{ id: "x", when: "sempre que…" }] }] }).ok).toBe(false);
    expect(parseSpec({ ...base, integrations: [{ ...integrations[3], phones: ["(11) 9999"] }] }).ok).toBe(false);
  });

  it("integração desligada não vira ferramenta", () => {
    const r = parseSpec({ ...base, integrations: [{ ...integrations[0], enabled: false }] });
    if (!r.ok) throw new Error("spec");
    expect(integrationTools(r.spec)).toEqual([]);
  });
});
