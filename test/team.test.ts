import { describe, expect, it } from "vitest";
import { teamPromptRules } from "../src/integrations/prompt.js";
import { fromChannel, matchAnswer, phoneForms, questionText, sameQuestion, stripCode, teamEventText } from "../src/runtime/team.js";
import { parseSpec } from "../src/spec/agent.js";
import { TeamQuestions } from "../src/spec/team.js";

const inbox = "998f613a-5822-40e2-9a28-fb367630cbb4";
const at = (min: number) => new Date(Date.UTC(2026, 9, 26, 15, min));

describe("especificação da consulta à equipe", () => {
  it("telefones ou grupo", () => {
    expect(TeamQuestions.safeParse({ channel: { inbox_id: inbox } }).success).toBe(false);
    expect(TeamQuestions.safeParse({ channel: { inbox_id: inbox, phones: ["5521982508868"] } }).success).toBe(true);
    expect(TeamQuestions.safeParse({ channel: { inbox_id: inbox, mode: "group", group_id: "1203630000@g.us" } }).success).toBe(true);
    expect(TeamQuestions.safeParse({ channel: { inbox_id: inbox, mode: "group" } }).success).toBe(false);
    const t = TeamQuestions.parse({ channel: { inbox_id: inbox, phones: ["5521982508868"] } });
    expect(t.timeout).toEqual({ minutes: 15, action: "remind", max_reminders: 2, give_up_guide: "" });
    expect(t.learn.enabled).toBe(true);
  });

  it("instruções no prompt só ligada", () => {
    const r = parseSpec({ persona: { name: "Luiza", company: "Estoque Car" }, instructions: { goal: "Vender" }, team_questions: { channel: { inbox_id: inbox, phones: ["5521982508868"] }, never: "parcela e aprovação" } });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(teamPromptRules(r.spec)).toContain("consultar_equipe");
    expect(teamPromptRules(r.spec)).toContain("parcela e aprovação");
    expect(teamPromptRules({ ...r.spec, team_questions: null })).toBeNull();
  });
});

describe("reconhecer a resposta", () => {
  const open = [
    { id: "a", code: "K7P2", sent_ids: ["3EB0AAA111"], asked_at: at(0) },
    { id: "b", code: "M4QX", sent_ids: ["3EB0BBB222"], asked_at: at(5) },
  ];

  it("pela mensagem citada", () => {
    expect(matchAnswer(open, { text: "R$ 89.900", replyId: "5521999:3EB0BBB222", at: at(10) }, true)).toEqual({ id: "b", answer: "R$ 89.900" });
  });
  it("pelo código", () => {
    expect(matchAnswer(open, { text: "#k7p2 sim, aceita troca", replyId: null, at: at(10) }, true)).toEqual({ id: "a", answer: "sim, aceita troca" });
    expect(matchAnswer(open, { text: "K7P2: sim", replyId: null, at: at(10) }, true)).toEqual({ id: "a", answer: "sim" });
  });
  it("uma dúvida só em aberto: a resposta direta vale; duas, não", () => {
    expect(matchAnswer([open[0]!], { text: "Sim", replyId: null, at: at(10) }, true)).toEqual({ id: "a", answer: "Sim" });
    expect(matchAnswer(open, { text: "Sim", replyId: null, at: at(10) }, true)).toBeNull();
    expect(matchAnswer([open[0]!], { text: "Sim", replyId: null, at: at(10) }, false)).toBeNull();
  });

  it("telefones com e sem o 9 e o grupo", () => {
    expect(phoneForms("5521982508868")).toEqual(["5521982508868", "552182508868"]);
    const ch = { mode: "phones" as const, inbox_id: inbox, phones: ["5521982508868"], group_id: "" };
    expect(fromChannel(ch, "552182508868")).toBe(true);
    expect(fromChannel(ch, "5521999990000")).toBe(false);
    expect(fromChannel({ ...ch, mode: "group", phones: [], group_id: "120363012345@g.us" }, "120363012345")).toBe(true);
  });

  it("mesma dúvida reformulada", () => {
    expect(sameQuestion("Preço do Compass 2019 prata", "Qual o preço do compass prata 2019?")).toBe(true);
    expect(sameQuestion("Preço do Compass 2019", "Aceita moto na troca?")).toBe(false);
  });

  it("textos para a equipe e para o agente", () => {
    const t = questionText({ agent: "Luiza", code: "K7P2", question: "Preço do Compass", context: "", contact: "Marcos", phone: "5521999991234", link: "" });
    expect(t).toContain("#K7P2");
    expect(t).toContain("•••••••••1234");
    expect(stripCode("#K7P2 89.900", "K7P2")).toBe("89.900");
    expect(teamEventText({ question: "Preço do Compass", answer: "R$ 89.900", answered_by: "Raiane" }, "answer")).toContain("R$ 89.900");
    expect(teamEventText({ question: "Preço", answer: null, answered_by: null }, "give_up", "ofereça a visita")).toContain("ofereça a visita");
  });
});
