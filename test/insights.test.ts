import { describe, expect, it } from "vitest";
import { parseGaps } from "../src/insights/gap-capture.js";
import { parseInsight } from "../src/insights/analyze.js";
import { periods, reportDigest, type Report } from "../src/insights/report.js";

describe("lacunas", () => {
  it("valida o que o agente avisou", () => {
    expect(
      parseGaps([
        { tipo: "pergunta", texto: "  Aceita   pagamento no boleto? " },
        { tipo: "objecao", texto: "Está caro", categoria: "Preço" },
        { tipo: "objeção", texto: "Vou pensar", categoria: "qualquer" },
        { tipo: "pergunta", texto: "aceita pagamento no boleto?" },
        { tipo: "pergunta", texto: "ok" },
        "lixo",
      ]),
    ).toEqual([
      { kind: "question", text: "Aceita pagamento no boleto?", category: "" },
      { kind: "objection", text: "Está caro", category: "preco" },
      { kind: "objection", text: "Vou pensar", category: "outro" },
    ]);
    expect(parseGaps(undefined)).toEqual([]);
  });
});

describe("leitura da conversa", () => {
  it("normaliza a resposta do modelo", () => {
    const r = parseInsight({
      intencao: "Quer saber o preço",
      resultado: "ghosted",
      motivo: "Parou de responder depois do preço",
      motivo_curto: "Preço Alto",
      sentimento: "negativo",
      objecoes: ["Preço", "preço", "  prazo "],
      assuntos: ["planos"],
      falhas_do_agente: [{ tipo: "repetition", detalhe: "Repetiu a apresentação" }, { tipo: "xpto", detalhe: "Outra" }, { tipo: "tone" }],
      resumo: "Lead perguntou o preço e sumiu.",
    });
    expect(r.outcome).toBe("ghosted");
    expect(r.sentiment).toBe("negative");
    expect(r.reason_label).toBe("preço alto");
    expect(r.objections).toEqual(["preço", "prazo"]);
    expect(r.agent_issues).toEqual([
      { type: "repetition", detail: "Repetiu a apresentação" },
      { type: "other", detail: "Outra" },
    ]);
    expect(parseInsight({ resultado: "inventado" }).outcome).toBe("other");
  });
});

describe("relatório", () => {
  it("período anterior do mesmo tamanho", () => {
    expect(periods("2026-10-01", "2026-10-07")).toEqual({
      cur: { from: "2026-10-01", to: "2026-10-07" },
      prev: { from: "2026-09-24", to: "2026-09-30" },
      days: 7,
    });
    expect(() => periods("2026-10-07", "2026-10-01")).toThrow();
    expect(() => periods("ontem", "hoje")).toThrow();
  });

  it("as conversas citadas viram códigos C1, C2…", () => {
    const metrics = {
      conversations: 10, new_conversations: 4, lead_messages: 50, agent_messages: 60, followup_messages: 3, followup_recovered: 1,
      turns: 40, errors: 0, handoffs: 2, meetings: 3, reply_ms_p50: 6000, cost_usd: 0.5, insights_cost_usd: 0.1,
    };
    const report = {
      period: { from: "2026-10-01", to: "2026-10-07" },
      previous: { from: "2026-09-24", to: "2026-09-30" },
      days: 7,
      sample_percent: 20,
      metrics,
      previous_metrics: { ...metrics, conversations: 5 },
      series: { days: [], hours: [] },
      insights: {
        analyzed: 2,
        outcomes: [{ outcome: "ghosted", n: 2 }],
        sentiment: [],
        reasons: [{ label: "preço alto", n: 2, conversations: ["a", "b"] }],
        objections: [],
        topics: [],
        issues: [],
      },
      previous_insights: { analyzed: 0, outcomes: [], sentiment: [] },
      look_at: [{ conversation_id: "a", summary: "Sumiu", outcome: "ghosted", sentiment: "neutral" }],
      gaps: { turns: 40, gap_turns: 4, gaps: 5, new_topics: 2, coverage: 0.9, top: [] },
      previous_gaps: { turns: 0, gap_turns: 0, gaps: 0, new_topics: 0, coverage: null },
    } as unknown as Report;
    const refs = new Map<string, string>();
    const text = reportDigest(report, refs);
    expect(text).toContain("preço alto 2 [C1,C2]");
    expect(text).toContain("C1: Sumiu (parou de responder, neutro)");
    expect(text).toContain("parou de responder 2 (100%)");
    expect(text).toContain("(+100%)");
    expect(text).toContain("cobertura 90%");
    expect([...refs]).toEqual([["a", "C1"], ["b", "C2"]]);
  });
});
