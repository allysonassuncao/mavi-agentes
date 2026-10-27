import { describe, expect, it } from "vitest";
import { parseSpec, type AgentSpec } from "../src/spec/agent.js";
import { pickStage, stageFactFields } from "../src/runtime/stages.js";
import { buildSystemPrompt, contextBlock } from "../src/runtime/prompt.js";
import { checkReply, correctionNote, numbersIn, patternHits } from "../src/runtime/guard.js";
import { builtinVars, runAction } from "../src/runtime/actions.js";
import { Action } from "../src/spec/actions.js";

const base = {
  persona: { name: "Luiza", company: "ESTOQUECAR" },
  instructions: { goal: "Levar o lead à visita.", conversation_guide: "1. Abertura. 2. Simulação." },
};

function spec(extra: Record<string, unknown>): AgentSpec {
  const r = parseSpec({ ...base, ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

/** As três etapas da Luiza: agendado (frase da mensagem final), aprovado (dado da simulação) e venda. */
const stages = {
  enabled: true,
  restart_after_days: 3,
  items: [
    { id: "agendado", name: "Agendado", when: { rules: [{ type: "said", texts: ["Agendado para o dia"] }] }, instructions: "Responda o mínimo.", hide_guide: true },
    { id: "aprovado", name: "Aprovado", when: { rules: [{ type: "fact", field: "aprovacao" }] }, instructions: "Toda resposta confirma que está APROVADO." },
    { id: "venda", name: "Venda", instructions: "Siga o roteiro." },
  ],
};

describe("etapas da conversa", () => {
  it("vale a primeira etapa cujas regras batem, de cima para baixo", () => {
    const s = spec({ stages });
    expect(pickStage(s, {}, [])?.id).toBe("venda");
    expect(pickStage(s, { aprovacao: "sim" }, [])?.id).toBe("aprovado");
    expect(pickStage(s, { aprovacao: "sim" }, ["Agendado para o dia 12/09 (sexta) às 14h ✅"])?.id).toBe("agendado");
    // sem diferenciar maiúsculas e acentos
    expect(pickStage(s, {}, ["agendado PARA o DIA 3"])?.id).toBe("agendado");
  });

  it("desligada ou sem etapa que bata: sem etapa", () => {
    expect(pickStage(spec({ stages: { ...stages, enabled: false } }), {}, [])).toBeNull();
    const s = spec({ stages: { enabled: true, items: [{ id: "aprovado", name: "Aprovado", when: { rules: [{ type: "fact", field: "aprovacao", op: "equals", value: "Sim" }] } }] } });
    expect(pickStage(s, { aprovacao: "não" }, [])).toBeNull();
    expect(pickStage(s, { aprovacao: "SIM" }, [])?.id).toBe("aprovado");
  });

  it("os dados das regras são os apagados na retomada", () => {
    expect(stageFactFields(spec({ stages }))).toEqual(["aprovacao"]);
  });

  it("o prompt leva as instruções da etapa e esconde o roteiro quando pedido", () => {
    const s = spec({ stages });
    const venda = buildSystemPrompt(s, pickStage(s, {}, []));
    expect(venda).toContain("# Como conduzir a conversa");
    expect(venda).toContain("# Etapa atual da conversa: Venda");
    expect(venda).toContain("Siga o roteiro.");
    expect(venda).toContain("As instruções das outras etapas (Agendado, Aprovado) não valem agora");
    const ag = buildSystemPrompt(s, pickStage(s, {}, ["Agendado para o dia 1"]));
    expect(ag).not.toContain("# Como conduzir a conversa");
    expect(ag).toContain("Responda o mínimo.");
    // sem etapa: igual a antes
    expect(buildSystemPrompt(s)).not.toContain("Etapa atual");
  });

  it("dados do sistema (com _) não vão para o agente", () => {
    const c = contextBlock({ facts: { nome: "Ana", _etapa_desde: "2026-10-27T10:00:00Z" }, summary: "", retrieved: [] });
    expect(c).toContain("nome: Ana");
    expect(c).not.toContain("_etapa_desde");
  });

  it("recusa etapa repetida, regra sem valor e etapas ligadas sem nenhuma", () => {
    const bad = parseSpec({
      ...base,
      stages: { enabled: true, items: [{ id: "a1", name: "A" }, { id: "a1", name: "B", when: { rules: [{ type: "fact", field: "x", op: "equals" }] } }] },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["stages.items.1.id", "stages.items.1.when.rules.0.value"]));
    expect(parseSpec({ ...base, stages: { enabled: true, items: [] } }).ok).toBe(false);
  });
});

/** Algumas conferências da v2 da Luiza, escritas como regras. */
const guard = {
  enabled: true,
  retries: 2,
  fallback_message: "Só um instante que já te respondo!",
  checks: [
    { id: "aprovacao", name: "Aprovação sem simulação", kind: "requires", patterns: ["/(foi|est[áa]) APROVAD[OA]/i"], tools: ["acao_simulacao"], facts: ["aprovacao"], message: "anunciou aprovação sem a simulação" },
    { id: "preco", name: "Preço de fonte", kind: "number_source", patterns: ["/faixa de R\\$\\s?([\\d.]+(?:,\\d{2})?)/i"], message: "preço que não veio do estoque" },
    { id: "validar", name: "Validar", severity: "leve", kind: "forbidden", patterns: ["validado", "/\\bvalida[çc][ãa]o\\b/i"], message: "usou validar" },
    { id: "perguntas", name: "Uma pergunta", severity: "leve", kind: "max_questions", max: 1, skip_stages: ["agendado"], message: "mais de uma pergunta" },
    { id: "ultima", name: "Pergunta no fim", severity: "leve", kind: "question_last", message: "a pergunta não é a última frase" },
  ],
};
const msg = (...t: string[]) => t.map((text) => ({ text, media: [] as string[] }));
const ctx = (over: Partial<Parameters<typeof checkReply>[2]> = {}) => ({ stageId: null, tools: [], facts: {}, sources: "", ...over });

describe("conferência da resposta", () => {
  const s = spec({ guard });

  it("aprovação só com a simulação desta vez ou com o dado já guardado", () => {
    const r = msg("Tenho ótimas notícias, Ana. O CPF foi APROVADO! 🎉", "Qual das duas fica melhor?");
    expect(checkReply(s, r, ctx()).map((v) => v.id)).toEqual(["aprovacao"]);
    expect(checkReply(s, r, ctx({ tools: [{ name: "acao_simulacao", ok: true, result: "" }] }))).toEqual([]);
    expect(checkReply(s, r, ctx({ tools: [{ name: "acao_simulacao", ok: false, result: "" }] })).map((v) => v.id)).toEqual(["aprovacao"]);
    expect(checkReply(s, r, ctx({ facts: { aprovacao: "sim" } }))).toEqual([]);
  });

  it("preço só se o número veio das ferramentas, da conversa ou dos dados", () => {
    const r = msg("O Onix está na faixa de R$ 68.900,00. Pretende à vista ou financiado?");
    expect(checkReply(s, r, ctx())[0]?.id).toBe("preco");
    expect(checkReply(s, r, ctx({ tools: [{ name: "api_estoque", ok: true, result: '{"Preco":68900}' }] }))).toEqual([]);
    expect(checkReply(s, r, ctx({ sources: "Lead: vi por 68.900" }))).toEqual([]);
  });

  it("texto simples sem diferenciar acentos, expressão entre barras, perguntas", () => {
    expect(checkReply(s, msg("Seu CPF foi VALIDADO"), ctx({ facts: { aprovacao: "1" } })).map((v) => v.id)).toEqual(["validar"]);
    expect(checkReply(s, msg("Qual seu nome?", "E à vista ou parcelado?"), ctx()).map((v) => v.id)).toEqual(["perguntas"]);
    expect(checkReply(s, msg("Qual seu nome?", "Ele é lindo"), ctx()).map((v) => v.id)).toEqual(["ultima"]);
    expect(checkReply(s, msg("Ele é lindo", "Qual seu nome? 😉"), ctx())).toEqual([]);
    // fora da etapa marcada
    expect(checkReply(s, msg("Pode vir?", "Traz o RG?"), ctx({ stageId: "agendado" })).map((v) => v.id)).toEqual([]);
    // desligada / resposta vazia
    expect(checkReply(spec({ guard: { ...guard, enabled: false } }), msg("foi APROVADO"), ctx())).toEqual([]);
    expect(checkReply(s, [], ctx())).toEqual([]);
  });

  it("o motivo volta ao agente com a resposta barrada e as ferramentas que já rodaram", () => {
    const v = checkReply(s, msg("O CPF foi APROVADO"), ctx());
    const note = correctionNote(v, msg("O CPF foi APROVADO"), ["mover_oportunidade"]);
    expect(note).toContain("RESPOSTA BLOQUEADA");
    expect(note).toContain("anunciou aprovação sem a simulação");
    expect(note).toContain("<bloqueada>\nO CPF foi APROVADO\n</bloqueada>");
    expect(note).toContain("mover_oportunidade");
  });

  it("padrões e números", () => {
    expect(numbersIn("R$ 68.900,00 em 60x de 1.182")).toEqual([68900, 60, 1182]);
    expect(patternHits("aprovado", "Foi APROVADO e aprovado").length).toBe(2);
    expect(patternHits("/x(\\d+)/", "x12 x3").map((m) => m[1])).toEqual(["12", "3"]);
  });

  it("recusa conferência sem padrão, requires sem ferramenta e regex inválida", () => {
    const r = parseSpec({
      ...base,
      guard: {
        enabled: true,
        checks: [
          { id: "a1", name: "A", kind: "forbidden", message: "xxx" },
          { id: "a2", name: "B", kind: "requires", patterns: ["x"], message: "xxx" },
          { id: "a3", name: "C", kind: "forbidden", patterns: ["/(/"], message: "xxx" },
        ],
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toEqual(["guard.checks.0.patterns", "guard.checks.1.tools", "guard.checks.2.patterns.0"]);
  });
});

describe("dados prontos das ações", () => {
  it("hoje, hora_agora e protocolo (AAMMDD + 4 dígitos)", () => {
    const vars = Object.fromEntries(builtinVars(new Date("2026-10-27T13:05:00Z")));
    expect(vars.hoje).toBe("27/10/2026");
    expect(vars.hora_agora).toBe("10:05");
    expect(String(vars.protocolo)).toMatch(/^261027\d{4}$/);
  });

  it("uma ação de protocolo usa os dados prontos", () => {
    const a = Action.parse({
      id: "agendar",
      name: "Registrar visita",
      when: "Lead confirmou dia e hora",
      inputs: [{ id: "data", label: "Data", type: "date" }, { id: "horario", label: "Horário", type: "text" }],
      result: { message: "Agendado. Protocolo: {protocolo} ({data_dia_semana}, registrado em {hoje})", save_facts: ["protocolo", "data", "horario"] },
    });
    const r = runAction(a, { data: "30/10/2026", horario: "14:00" }, { phone: null, contactName: null, facts: {} }, new Date("2026-10-27T13:05:00Z"));
    expect(r.status).toBe("done");
    expect(r.message).toMatch(/^Agendado\. Protocolo: 261027\d{4} \(sexta-feira, registrado em 27\/10\/2026\)$/);
    expect(r.facts.protocolo).toMatch(/^261027\d{4}$/);
    // não dá para usar o nome de um dado pronto numa conta
    expect(Action.safeParse({ ...a, steps: [{ id: "x1", kind: "text", target: "hoje", template: "a" }] }).success).toBe(false);
  });
});
