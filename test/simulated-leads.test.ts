import { describe, expect, it } from "vitest";
import { issueScore, JUDGE_RULES, judgeConfig, parseCompare, parsePersonas, parseVerdict, summarize } from "../src/tests/runner.js";

describe("testes com leads simulados", () => {
  it("perfis: valida, corta e completa", () => {
    const p = parsePersonas(
      {
        personas: [
          { nome: "Mariana", perfil: "preco", descricao: "Dona de clínica", objetivo: "Saber o preço", objecoes: ["caro", "", "concorrente"], estilo: "curto" },
          { nome: "X", perfil: "inventado", descricao: "Alguém", objetivo: "Algo" },
          { nome: "Sem objetivo", perfil: "cetico", descricao: "..." },
          { nome: "Excedente", perfil: "cetico", descricao: "a", objetivo: "b" },
        ],
      },
      2,
    );
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ nome: "Mariana", perfil: "preco", objecoes: ["caro", "concorrente"] });
    expect(p[1]!.perfil).toBe("interessado");
    expect(parsePersonas({}, 3)).toEqual([]);
  });

  it("avaliação: nota de 0 a 10, tipos conhecidos, lacunas", () => {
    const v = parseVerdict({
      nota: 12,
      objetivo_atingido: true,
      resultado: "scheduled",
      problemas: [{ tipo: "wrong_info", gravidade: 5, detalhe: "Inventou preço", trecho: "R$ 99" }, { tipo: "xpto", detalhe: "Outro" }, { tipo: "tone" }],
      lacunas: [{ tipo: "pergunta", texto: "Aceita boleto?" }],
      pontos_fortes: ["Educado"],
      resumo: "Agendou.",
    });
    // A nota sai dos problemas (10 − 3 grave − 0,5 leve); a do avaliador fica guardada.
    expect(v.score).toBe(6.5);
    expect(v.judge_score).toBe(10);
    expect(v.outcome).toBe("scheduled");
    expect(v.issues).toEqual([
      { type: "wrong_info", severity: 3, detail: "Inventou preço", quote: "R$ 99" },
      { type: "other", severity: 1, detail: "Outro", quote: "" },
    ]);
    expect(v.gaps).toEqual([{ kind: "question", text: "Aceita boleto?", category: "" }]);
    expect(parseVerdict({ resultado: "?" }).outcome).toBe("other");
  });

  it("resumo da bateria", () => {
    const verdict = (score: number, goal: boolean, issues: { type: string; severity: number }[] = []) => ({
      score,
      goal_reached: goal,
      outcome: goal ? "scheduled" : "ghosted",
      issues: issues.map((i) => ({ ...i, detail: i.type, quote: "" })),
      gaps: [],
      strengths: [],
      summary: "",
    });
    const s = summarize([
      { status: "done", verdict: verdict(8, true) },
      { status: "done", verdict: verdict(5, false, [{ type: "wrong_info", severity: 3 }, { type: "tone", severity: 1 }]) },
      { status: "error", verdict: null },
    ]);
    expect(s).toMatchObject({ conversations: 3, evaluated: 2, errors: 1, score: 6.5, goal_rate: 0.5, severe: 1, outcomes: { scheduled: 1, ghosted: 1 } });
    expect(s.issues.wrong_info!.n).toBe(1);
  });
});

describe("reencenar conversas reais", () => {
  const turns = [
    { lead: "oi, tem o onix 2020?", original: "Tenho sim! Quer ver fotos?", agent: "Tenho o Onix 2020 por R$ 62.900. Quer as fotos?" },
    { lead: "quanto fica a parcela", original: "Fica R$ 1.200", agent: "Depende da entrada" },
  ];
  it("lê o avaliador vez a vez e conta melhor, igual e pior", () => {
    const c = parseCompare([{ vez: 1, resultado: "melhor", motivo: "deu o preço" }, { vez: 2, resultado: "pior", motivo: "não simulou" }, { vez: 9, resultado: "pior" }], turns);
    expect(c).toMatchObject({ better: 1, same: 0, worse: 1 });
    expect(c.turns.map((t) => [t.t, t.result, t.why])).toEqual([
      [1, "melhor", "deu o preço"],
      [2, "pior", "não simulou"],
    ]);
    expect(parseCompare([{ vez: 1, resultado: "talvez" }], turns.slice(0, 1)).turns[0]!.result).toBe("igual");
  });
  it("o resumo da bateria soma a comparação", () => {
    const v = { score: 7, goal_reached: true, outcome: "scheduled", issues: [], gaps: [], strengths: [], summary: "" };
    const s = summarize([
      { status: "done", verdict: { ...v, compare: parseCompare([{ vez: 1, resultado: "melhor" }], turns.slice(0, 1)) } },
      { status: "done", verdict: { ...v, compare: parseCompare([{ vez: 1, resultado: "igual" }, { vez: 2, resultado: "pior" }], turns) } },
    ]);
    expect(s.replay).toEqual({ better: 1, same: 1, worse: 1 });
    expect(summarize([{ status: "done", verdict: v }]).replay).toBeUndefined();
  });
});

describe("a régua do avaliador", () => {
  it("a nota pelos problemas: gravidade e objetivo (fim justo não tira)", () => {
    expect(issueScore([], true, "scheduled")).toBe(10);
    expect(issueScore([{ severity: 2 }, { severity: 2 }, { severity: 1 }], true, "scheduled")).toBe(6.5);
    expect(issueScore([], false, "in_progress")).toBe(9);
    expect(issueScore([], false, "not_interested")).toBe(10);
    expect(issueScore(Array.from({ length: 6 }, () => ({ severity: 3 })), true, "other")).toBe(0);
    expect(parseVerdict({ problemas: [{ tipo: "wrong_info", gravidade: 2, detalhe: "x", fonte: "api_estoque: encontrados 0" }] }).issues[0]!.source).toBe("api_estoque: encontrados 0");
  });

  it("o avaliador vê o roteiro, o estilo, as instruções adicionais e as regras do que é inventado", () => {
    const spec = {
      persona: { name: "Luiza", company: "Estoquecar", segment: "", company_summary: "Loja de seminovos", tone: "comercial e objetiva", reply_size: "short", emoji: "few" },
      instructions: { goal: "Agendar a visita", conversation_guide: "1. Abertura", rules: ["Nunca invente parcela"], never: ["Prometer aprovação"], extra: "# GATE DA VISITA", weekly_hours: null, business_hours: "8h às 18h" },
      handoff: { enabled: true, when: "Cliente reclamando" },
      output: { max_messages: 8 },
    } as never;
    const c = judgeConfig(spec);
    for (const t of ["1. Abertura", "# GATE DA VISITA", "Tom: comercial e objetiva", "Nunca invente parcela", "Prometer aprovação", "8h às 18h", "Cliente reclamando"]) expect(c).toContain(t);
    expect(JUDGE_RULES).toContain("O que veio de uma ferramenta não é inventado");
    expect(JUDGE_RULES).toContain("nome no perfil do WhatsApp");
    expect(JUDGE_RULES).toContain("a MAVI responde às consultas à equipe");
  });
});
