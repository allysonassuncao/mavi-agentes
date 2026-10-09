import { describe, expect, it } from "vitest";
import { parsePersonas, parseVerdict, summarize } from "../src/tests/runner.js";

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
    expect(v.score).toBe(10);
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
