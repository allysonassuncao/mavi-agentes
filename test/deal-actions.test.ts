import { beforeEach, describe, expect, it, vi } from "vitest";

// MakeCRM de mentira: guarda cada chamada e responde pelas tabelas abaixo.
const calls: { method: string; path: string; body: unknown }[] = [];
let tables: Record<string, unknown[]> = {};
vi.mock("../src/makecrm/client.js", () => ({
  rest: vi.fn(async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    if (method !== "GET") return null;
    return tables[path.split("?")[0]!] ?? [];
  }),
}));
vi.mock("../src/config.js", () => ({
  config: () => ({
    MAKECRM_AUTOMATIONS_URL: "https://hooks.test/e3a08c6a",
    MAKECRM_LOST_URL: "https://hooks.test/1376ad4c",
    MAKECRM_WON_URL: "https://hooks.test/cbfe7df7",
    MAKECRM_MEET_DELETE_URL: "https://hooks.test/bb914715",
  }),
}));
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
vi.stubGlobal("fetch", fetchMock);

const { parseSpec } = await import("../src/spec/agent.js");
const { integrationTools, runIntegrationTool } = await import("../src/integrations/index.js");
const { scenarioPrompt, integrationsPrompt } = await import("../src/integrations/prompt.js");
const { scenarioTool, runScenario } = await import("../src/runtime/scenarios.js");
const { markLost, markWon, createQuote, createActivity, activityAssignee } = await import("../src/integrations/deal-actions.js");

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { persona: { name: "Clara", company: "X" }, instructions: { goal: "y" } };
const dealActions = {
  type: "makecrm_deal_actions",
  lost: { enabled: true, reasons: [{ id: uid(1), name: "Sem interesse" }, { id: uid(2), name: "Concorrência" }] },
  won: { enabled: true },
  quote: { enabled: true, products: [{ product_id: uid(3), name: "Plano anual", max_discount_pct: 10 }] },
  note: { enabled: true },
  activity: { enabled: true, types: [{ id: uid(4), name: "Ligação" }], assignee: { mode: "fixed", user_id: uid(5) } },
};
const optOut = {
  id: "nao_contatar",
  name: "Não quer mais contato",
  when: "O lead pede para não receber mais mensagens",
  reply: "fixed",
  message: "Tudo bem, não vamos mais te chamar. Obrigado!",
  actions: { turn_off_ai: true, lost_reason_id: uid(1) },
};

function spec(extra: Record<string, unknown>) {
  const r = parseSpec({ ...base, ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}
const deal = {
  id: uid(10),
  pipeline_id: uid(11),
  stage_id: uid(12),
  contact_id: uid(13),
  user_id: uid(14),
  sdr_id: null,
  closer_id: uid(15),
  name: "Lead",
  status: 1,
  source_id: null,
  campaign_id: null,
  updated_at: "2026-10-09T10:00:00Z",
};
const ctxOf = (s: ReturnType<typeof spec>, simulation = false) => ({
  agentId: uid(20),
  agentName: "Clara",
  spec: s,
  simulation,
  conversationId: uid(21),
  makecrmConversationId: simulation ? null : uid(22),
  inboxId: uid(23),
  companyId: uid(24),
  maviUserId: uid(25),
  contactName: "Lead",
  phone: "5511999999999",
  facts: {},
  summary: "",
});

beforeEach(() => {
  calls.length = 0;
  fetchMock.mockClear();
  tables = { currencys: [{ id: 1, code: "BRL", symbol: "R$" }] };
});

describe("ações na oportunidade: especificação e ferramentas", () => {
  it("valida, gera as 5 ferramentas com códigos curtos e o prompt", () => {
    const s = spec({ integrations: [dealActions] });
    const tools = integrationTools(s);
    expect(tools.map((t) => t.function.name)).toEqual(["dar_como_perdido", "dar_como_ganho", "registrar_orcamento", "registrar_no_historico", "criar_atividade"]);
    const lost = tools[0]!.function;
    expect(lost.description).toContain("R1: Sem interesse");
    expect((lost.parameters as { properties: { motivo: { enum: string[] } } }).properties.motivo.enum).toEqual(["R1", "R2"]);
    expect(tools[2]!.function.description).toContain("P1: Plano anual (desconto máximo 10%)");
    expect(integrationsPrompt(s)).toContain("ações na oportunidade");
  });

  it("só as ações ligadas; recusa sem motivos, sem produtos, sem tipos ou tudo desligado", () => {
    const s = spec({ integrations: [{ type: "makecrm_deal_actions", note: { enabled: true } }] });
    expect(integrationTools(s).map((t) => t.function.name)).toEqual(["registrar_no_historico"]);
    expect(parseSpec({ ...base, integrations: [{ type: "makecrm_deal_actions" }] }).ok).toBe(false);
    expect(parseSpec({ ...base, integrations: [{ type: "makecrm_deal_actions", lost: { enabled: true } }] }).ok).toBe(false);
    expect(parseSpec({ ...base, integrations: [{ type: "makecrm_deal_actions", quote: { enabled: true } }] }).ok).toBe(false);
    expect(parseSpec({ ...base, integrations: [{ type: "makecrm_deal_actions", activity: { enabled: true } }] }).ok).toBe(false);
    expect(parseSpec({ ...base, integrations: [{ ...dealActions, activity: { ...dealActions.activity, assignee: { mode: "fixed" } } }] }).ok).toBe(false);
  });
});

describe("cenários: especificação e ferramenta", () => {
  it("vira a ferramenta acionar_cenario e uma seção do prompt", () => {
    const s = spec({ scenarios: [optOut] });
    const t = scenarioTool(s)!;
    expect(t.function.name).toBe("acionar_cenario");
    expect(t.function.description).toContain("nao_contatar: O lead pede para não receber mais mensagens");
    expect(scenarioPrompt(s)).toContain("# Cenários combinados");
    expect(s.scenarios[0]!.actions.stop_followup).toBe(true);
  });

  it("recusa resposta fixa sem mensagem e códigos repetidos; desligado não vira ferramenta", () => {
    expect(parseSpec({ ...base, scenarios: [{ ...optOut, message: "" }] }).ok).toBe(false);
    expect(parseSpec({ ...base, scenarios: [optOut, optOut] }).ok).toBe(false);
    expect(scenarioTool(spec({ scenarios: [{ ...optOut, enabled: false }] }))).toBeNull();
    expect(scenarioPrompt(spec({}))).toBe("");
  });

  it("na simulação só diz o que faria (nada gravado no CRM)", async () => {
    tables.lost_reasons = [{ name: "Sem interesse" }];
    const s = spec({ scenarios: [optOut] });
    const r = await runScenario(s, { cenario: "nao_contatar", motivo: "pediu para parar" }, ctxOf(s, true));
    expect(r.result).toContain("perdida (Sem interesse)");
    expect(r.result).toContain("desligar a MAVI nesta conversa");
    expect(r.hit?.scenario.id).toBe("nao_contatar");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("ações na oportunidade: igual à tela do MakeCRM", () => {
  it("perdido: registro da perda, status 0, histórico e webhook de automação", async () => {
    tables.lost_reasons = [{ id: uid(1), name: "Sem interesse" }];
    tables.pipeline_deal_activities = [{ id: uid(30) }];
    const s = spec({ integrations: [dealActions] });
    const name = await markLost(ctxOf(s), deal, uid(1), "pediu para parar", { cancelMeetings: false, completeActivities: true });
    expect(name).toBe("Sem interesse");
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.find((c) => c.path.startsWith("pipeline_deal_activities?id=in."))?.body).toEqual({ status: 2 });
    expect(writes.find((c) => c.path === "pipeline_deal_losts")?.body).toEqual({ deal_id: deal.id, reason_id: uid(1), description: "pediu para parar" });
    expect((writes.find((c) => c.path === `pipeline_deals?id=eq.${deal.id}` && (c.body as { status?: number }).status === 0)?.body as { status: number }).status).toBe(0);
    expect(writes.some((c) => c.path === "pipeline_deal_stories" && String((c.body as { content: string }).content).startsWith("Oportunidade perdida por Sem interesse."))).toBe(true);
    const hook = fetchMock.mock.calls.find((c) => String(c[0]).includes("1376ad4c"));
    expect(JSON.parse(String((hook![1] as RequestInit).body))).toMatchObject({ deal_id: deal.id, lost_reasons_id: uid(1), company_id: uid(24), closer_id: uid(15) });
  });

  it("ganho: exige orçamento; com orçamento grava ganhos, status 2, resumos, preço fechado e webhook", async () => {
    const s = spec({ integrations: [dealActions] });
    expect(await markWon(ctxOf(s), deal, "")).toEqual({ ok: false, reason: "no_quote" });
    tables.pipeline_deal_quotes = [{ id: uid(40), quoted_price: 900, closed_price: null, currency: 1, product: { id: uid(3), name: "Plano anual" } }];
    const r = await markWon(ctxOf(s), deal, "pagou o Pix");
    expect(r).toEqual({ ok: true, total: expect.stringContaining("900") });
    const writes = calls.filter((c) => c.method !== "GET");
    const wons = writes.find((c) => c.path === "pipeline_deal_wons")!.body as { quote_id: string; date: string }[];
    expect(wons[0]!.quote_id).toBe(uid(40));
    expect(wons[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const upd = writes.find((c) => c.path === `pipeline_deals?id=eq.${deal.id}`)!.body as Record<string, unknown>;
    expect(upd).toMatchObject({ status: 2, value: 900, products_id: [{ id: uid(3), name: "Plano anual" }] });
    expect(upd.quotes).toEqual([{ quotes: [{ id: uid(40), product_name: "Plano anual", currency: 1, value: 900, code: "BRL", symbol: "R$" }], total: [{ currency: 1, code: "BRL", symbol: "R$", value: 900 }] }]);
    expect(writes.find((c) => c.path === `pipeline_deal_quotes?id=eq.${uid(40)}`)?.body).toEqual({ closed_price: 900 });
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("cbfe7df7"))).toBe(true);
  });

  it("orçamento: grava com a moeda do produto e recalcula valor, produtos e resumo", async () => {
    tables.pipeline_deal_quotes = [{ id: uid(41), quoted_price: 850, closed_price: null, currency: 1, product: { id: uid(3), name: "Plano anual" } }];
    const s = spec({ integrations: [dealActions] });
    const label = await createQuote(ctxOf(s), deal, { id: uid(3), name: "Plano anual", price: 900, currency: 1 }, 850, "12x");
    expect(label).toContain("850");
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.find((c) => c.path === "pipeline_deal_quotes")?.body).toMatchObject({ deal_id: deal.id, product_id: uid(3), quoted_price: 850, currency: 1, description: "12x" });
    expect(writes.find((c) => c.path === `pipeline_deals?id=eq.${deal.id}`)?.body).toMatchObject({ value: 850, products_id: [{ id: uid(3), name: "Plano anual" }] });
  });

  it("orçamento pela ferramenta: recusa abaixo do desconto máximo (na simulação também)", async () => {
    tables.products = [{ id: uid(3), name: "Plano anual", price: 1000, currency: 1, status: true }];
    const s = spec({ integrations: [dealActions] });
    const low = await runIntegrationTool("registrar_orcamento", { produto: "P1", valor: 850 }, ctxOf(s, true));
    expect(low.result).toContain("mínimo para este produto é 900.00");
    const ok = await runIntegrationTool("registrar_orcamento", { produto: "P1", valor: "R$ 950,00" }, ctxOf(s, true));
    expect(ok.result).toContain("por 950.00");
    const list = await runIntegrationTool("registrar_orcamento", { produto: "P1" }, ctxOf(s, true));
    expect(list.result).toContain("por 1000.00");
  });

  it("atividade: responsável pelo papel (senão quem assume), fixo; e o resumo da oportunidade", async () => {
    const s = spec({ integrations: [dealActions] });
    const ctx = ctxOf(s);
    expect(await activityAssignee(ctx, deal, { mode: "deal_role", role: "closer", user_id: null, users: [] }, "k")).toBe(uid(15));
    expect(await activityAssignee(ctx, deal, { mode: "deal_role", role: "sdr", user_id: uid(7), users: [] }, "k")).toBe(uid(7));
    expect(await activityAssignee(ctx, deal, { mode: "deal_role", role: "sdr", user_id: null, users: [] }, "k")).toBe(uid(14));
    expect(await activityAssignee(ctx, deal, { mode: "fixed", role: "owner", user_id: uid(5), users: [] }, "k")).toBe(uid(5));
    tables.pipeline_deal_activities = [{ id: uid(50), subject: "Ligar", status: 1, do_in: null, created_at: "x" }];
    await createActivity(ctx, deal, { typeId: uid(4), subject: "Ligar", description: "", doIn: new Date("2026-10-10T12:00:00Z"), userId: uid(5) });
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes[0]!.body).toMatchObject({ deal_id: deal.id, user_id: uid(5), type_id: uid(4), subject: "Ligar", status: 1, do_in: "2026-10-10T12:00:00.000Z" });
    expect(writes[1]!.body).toEqual({ activities: tables.pipeline_deal_activities });
  });
});
