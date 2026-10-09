import { describe, expect, it } from "vitest";
import { reminderVars, stepDue, stepState } from "../src/runtime/reminders.js";
import { parseSpec } from "../src/spec/agent.js";
import { MeetingReminders } from "../src/spec/reminders.js";

const step = (o: Record<string, unknown>) => MeetingReminders.parse({ steps: [{ id: "a", minutes: 10, text: "Oi", ...o }] }).steps[0]!;
// Reunião na terça 13/10/2026 às 10:00 (Brasília), 30 min; marcada na sexta 09/10.
const m = { starts_at: new Date("2026-10-13T13:00:00Z"), ends_at: new Date("2026-10-13T13:30:00Z"), scheduled_at: new Date("2026-10-09T20:00:00Z") };
const week = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { from: "08:00", to: "18:00" }]));

describe("régua de pré-reunião", () => {
  it("antes do início e depois do fim", () => {
    expect(stepDue(step({ minutes: 10 }), m, null)!.toISOString()).toBe("2026-10-13T12:50:00.000Z");
    expect(stepDue(step({ minutes: 30 }), m, null)!.toISOString()).toBe("2026-10-13T12:30:00.000Z");
    expect(stepDue(step({ when: "after", minutes: 15 }), m, null)!.toISOString()).toBe("2026-10-13T13:45:00.000Z");
  });

  it("horário comercial: 1 dia antes às 10:00 cai dentro; 1 dia + 3 h antes (07:00) vai para as 08:00; curtos ignoram a janela", () => {
    expect(stepDue(step({ minutes: 1440 }), m, week)!.toISOString()).toBe("2026-10-12T13:00:00.000Z");
    expect(stepDue(step({ minutes: 1440 + 180 }), m, week)!.toISOString()).toBe("2026-10-12T11:00:00.000Z");
    const early = { ...m, starts_at: new Date("2026-10-13T11:03:00Z"), ends_at: new Date("2026-10-13T11:33:00Z") }; // 08:03
    expect(stepDue(step({ minutes: 10 }), early, week)!.toISOString()).toBe("2026-10-13T10:53:00.000Z"); // 07:53, fora da janela, mas curto
    // 2 h antes de 08:03 = 06:03 → a abertura (08:00) fica a menos de 5 min do início: não sai.
    expect(stepDue(step({ minutes: 120 }), early, week)).toBeNull();
  });

  it("estado: espera, envia, pula atrasada, marcada depois do momento e reunião já começada", () => {
    const s = step({ minutes: 60 });
    expect(stepState(s, m, null, new Date("2026-10-13T11:00:00Z")).action).toBe("wait");
    expect(stepState(s, m, null, new Date("2026-10-13T12:01:00Z")).action).toBe("send");
    expect(stepState(s, m, null, new Date("2026-10-13T12:45:00Z"))).toMatchObject({ action: "skip", reason: expect.stringContaining("30 minutos") });
    expect(stepState(step({ minutes: 1440 }), { ...m, scheduled_at: new Date("2026-10-13T10:00:00Z") }, null, new Date("2026-10-13T10:01:00Z"))).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("marcada depois"),
    });
    expect(stepState(step({ minutes: 5 }), m, null, new Date("2026-10-13T13:01:00Z"))).toMatchObject({ action: "skip", reason: "a reunião já começou" });
  });

  it("variáveis da mensagem", () => {
    const v = reminderVars({ contactName: "Ana Paula", agent: "Clara", company: "Make", host: "Bruno", meeting: { starts_at: m.starts_at, link: "https://meet.google.com/x" } });
    expect(v).toMatchObject({ primeiro_nome: "Ana", data: "13/10", hora: "10:00", dia_semana: "terça-feira", anfitriao: "Bruno", link: "https://meet.google.com/x" });
  });

  it("especificação: confirmação só antes, texto fixo exige texto, sem duas etapas no mesmo momento", () => {
    const base = { persona: { name: "Clara", company: "X" }, instructions: { goal: "y" } };
    const ok = parseSpec({ ...base, meeting_reminders: { steps: [{ id: "a", minutes: 1440, confirm: true, mode: "ai" }, { id: "b", minutes: 10, text: "Começa em 10 min: {link}" }] } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.spec.meeting_reminders).toMatchObject({ when_ai_off: "send", confirmation: { alert_minutes_before: 60, notify_on_decline: true } });
    expect(parseSpec({ ...base, meeting_reminders: { steps: [{ id: "a", when: "after", minutes: 10, text: "x", confirm: true }] } }).ok).toBe(false);
    expect(parseSpec({ ...base, meeting_reminders: { steps: [{ id: "a", minutes: 10 }] } }).ok).toBe(false);
    expect(parseSpec({ ...base, meeting_reminders: { steps: [{ id: "a", minutes: 10, text: "x" }, { id: "b", minutes: 10, text: "y" }] } }).ok).toBe(false);
  });
});
