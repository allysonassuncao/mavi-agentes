import { describe, expect, it } from "vitest";
import { apiTools, buildRequest, matchFilter, parseOAuthSecret, resolveValues, responseMedia, runApiTool, shapeResponse, statusError } from "../src/integrations/apis.js";
import { jsonPaths } from "../src/api/routes/apis.js";
import { parseSpec } from "../src/spec/agent.js";
import { ExternalApi } from "../src/spec/apis.js";
import { contextBlock } from "../src/runtime/prompt.js";

const base = {
  id: "pedido",
  name: "Status do pedido",
  when: "Quando o lead perguntar do pedido",
  url: "https://api.loja.com/v1/pedidos/{numero}",
  params: [
    { name: "numero", in: "path", description: "Número do pedido" },
    { name: "fields", in: "query", source: "fixed", value: "status,prazo" },
    { name: "telefone", in: "query", source: "contact", value: "phone", required: false },
  ],
  auth: { type: "bearer" },
};

const spec = (apis: unknown[]) => {
  const r = parseSpec({ persona: { name: "Ana", company: "Loja" }, instructions: { goal: "Atender" }, apis });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
};

describe("especificação das APIs", () => {
  it("aceita e completa os padrões", () => {
    const a = ExternalApi.parse(base);
    expect(a.method).toBe("GET");
    expect(a.kind).toBe("read");
    expect(a.response.max_chars).toBe(3000);
  });

  it("aponta campo do caminho que falta e corpo em GET", () => {
    const r = ExternalApi.safeParse({ ...base, url: "https://x.com/{a}/{numero}", params: [...base.params, { name: "b", in: "body" }] });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => i.message).join(" | ");
    expect(msgs).toContain("{a}");
    expect(msgs).toContain("GET não tem corpo");
  });

  it("no começo da conversa só com dados fixos/do contato e só consulta", () => {
    const r = ExternalApi.safeParse({ ...base, on_start: true });
    expect(r.success).toBe(false);
    const ok = ExternalApi.safeParse({ ...base, url: "https://x.com/clientes", params: [{ name: "tel", in: "query", source: "contact", value: "phone" }], on_start: true });
    expect(ok.success).toBe(true);
    const w = ExternalApi.safeParse({ ...base, url: "https://x.com/c", params: [], kind: "write", method: "POST", on_start: true });
    expect(w.success).toBe(false);
  });

  it("códigos repetidos no agente", () => {
    const r = parseSpec({ persona: { name: "Ana", company: "Loja" }, instructions: { goal: "x" }, apis: [base, base] });
    expect(r.ok).toBe(false);
  });
});

describe("ferramentas", () => {
  it("só os campos do agente viram argumentos; enviar pede confirmação", () => {
    const s = spec([base, { ...base, id: "criar", name: "Criar pedido", kind: "write", method: "POST", url: "https://x.com/p", params: [{ name: "cliente.nome", in: "body" }] }]);
    const [read, write] = apiTools(s);
    expect(read!.function.name).toBe("api_pedido");
    expect(Object.keys((read!.function.parameters as any).properties)).toEqual(["numero"]);
    expect(write!.function.description).toContain("ENVIA dados");
    expect((write!.function.parameters as any).required).toEqual(["cliente_nome", "confirmado_pelo_lead"]);
  });
});

describe("montar a chamada", () => {
  const api = ExternalApi.parse(base);

  it("caminho, query fixa, contato e chave mascarada", () => {
    const { values, missing } = resolveValues(api, { numero: "A 12/3" }, { phone: "5511999", contactName: null, facts: {} });
    expect(missing).toEqual([]);
    const r = buildRequest(api, values, "segredo-muito-longo-1234");
    expect(r.url).toBe("https://api.loja.com/v1/pedidos/A%2012%2F3?fields=status%2Cprazo&telefone=5511999");
    expect(r.headers.authorization).toBe("Bearer segredo-muito-longo-1234");
    expect(r.preview.headers.Authorization).toBe("Bearer ••••1234");
    expect(r.body).toBeUndefined();
  });

  it("falta dado obrigatório", () => {
    const { missing } = resolveValues(api, {}, { phone: null, contactName: null, facts: {} });
    expect(missing).toEqual(["Número do pedido"]);
  });

  it("corpo JSON aninhado, tipos e chave na query mascarada", () => {
    const w = ExternalApi.parse({
      ...base,
      kind: "write",
      method: "POST",
      url: "https://x.com/p",
      params: [
        { name: "cliente.nome", in: "body" },
        { name: "qtd", in: "body", type: "integer" },
        { name: "vip", in: "body", type: "boolean", source: "contact", value: "fact:vip" },
      ],
      auth: { type: "query", name: "token" },
    });
    const { values } = resolveValues(w, { cliente_nome: "Ana", qtd: "2,7" }, { phone: null, contactName: null, facts: { vip: "sim" } });
    const r = buildRequest(w, values, "abcdefghijk");
    expect(JSON.parse(r.body!)).toEqual({ cliente: { nome: "Ana" }, qtd: 2, vip: true });
    expect(r.url).toBe("https://x.com/p?token=abcdefghijk");
    expect(r.preview.url).toBe("https://x.com/p?token=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2hijk");
  });

  it("sem a chave salva não chama", () => {
    const { values } = resolveValues(api, { numero: "1" }, { phone: null, contactName: null, facts: {} });
    expect(() => buildRequest(api, values, null)).toThrow(/chave/);
  });
});

describe("resposta", () => {
  it("guarda só os caminhos escolhidos (inclusive de listas) e corta", () => {
    const api = ExternalApi.parse({ ...base, response: { pick: ["status", "itens.nome", "itens.0.preco", "nada"], max_chars: 200 } });
    const out = shapeResponse(api, { json: { status: "enviado", itens: [{ nome: "A", preco: 10 }, { nome: "B", preco: 20 }], lixo: "x" }, text: "" });
    expect(JSON.parse(out)).toEqual({ status: "enviado", "itens.nome": ["A", "B"], "itens.0.preco": 10 });
    const short = shapeResponse(ExternalApi.parse({ ...base, response: { max_chars: 200 } }), { json: null, text: "a".repeat(300) });
    expect(short.endsWith("… (cortado)")).toBe(true);
  });

  it("erros HTTP viram motivos", () => {
    expect(statusError(401, "").code).toBe("api_auth");
    expect(statusError(404, "").code).toBe("api_not_found");
    expect(statusError(422, "campo x").message).toContain("campo x");
    expect(statusError(503, "").code).toBe("api_server");
  });

  it("caminhos para escolher", () => {
    expect(jsonPaths({ a: 1, b: { c: [{ d: 1, e: 2 }] }, f: [1, 2] })).toEqual(["a", "b.c.d", "b.c.e", "f"]);
  });
});

describe("na conversa", () => {
  const s = spec([{ ...base, auth: { type: "none" } }, { ...base, id: "criar", name: "Criar", kind: "write", method: "POST", url: "https://x.com/p", params: [], auth: { type: "none" } }]);
  const ctx = { agentId: "a", simulation: true, spec: s, phone: null, contactName: null, facts: {} };

  it("falta dado: pede ao lead", async () => {
    const r = await runApiTool("api_pedido", {}, ctx);
    expect(r.debug.code).toBe("api_missing");
  });

  it("envio sem confirmação não sai; no teste, com confirmação, só simula", async () => {
    expect((await runApiTool("api_criar", {}, ctx)).debug.code).toBe("api_needs_confirmation");
    const r = await runApiTool("api_criar", { confirmado_pelo_lead: true }, ctx);
    expect(r.debug.outcome).toBe("simulated");
    expect(r.result).toContain("nada foi enviado");
  });

  it("contexto com os dados do começo da conversa", () => {
    expect(contextBlock({ facts: {}, summary: "", retrieved: [], apis: ["Cliente: {\"plano\":\"ouro\"}"] })).toContain("Dados de outros sistemas");
  });
});

describe("lista, filtros e mídias da resposta", () => {
  const estoque = ExternalApi.parse({
    id: "estoque",
    name: "Estoque",
    when: "Quando o lead perguntar de um carro",
    url: "https://api.loja.com/estoque",
    params: [
      { name: "Modelo", in: "filter", description: "Modelo", required: false },
      { name: "Preco", in: "filter", source: "fixed", value: "50000", match: "gte" },
    ],
    response: { list: { path: "", max_items: 2 }, pick: ["Codigo", "Modelo", "Preco"], media: { path: "Fotos.URL", max: 3 } },
  });
  const json = [
    { Codigo: 1, Modelo: "ÔNIX LT", Preco: 68900, Fotos: [{ URL: "https://f.com/1a.jpg" }, { URL: "https://f.com/1b.jpg" }] },
    { Codigo: 2, Modelo: "Onix Plus", Preco: 79900, Fotos: [{ URL: "https://f.com/2a.jpg" }, { URL: "javascript:alert(1)" }] },
    { Codigo: 3, Modelo: "HB20", Preco: 59900, Fotos: [] },
    { Codigo: 4, Modelo: "Onix", Preco: 39900, Fotos: [{ URL: "https://f.com/4a.jpg" }] },
  ];

  it("filtro só vale com lista", () => {
    const r = ExternalApi.safeParse({ ...base, params: [...base.params, { name: "Modelo", in: "filter" }] });
    expect(r.success).toBe(false);
  });

  it("filtra sem acento e maiúsculas, compara número e corta em max_items", () => {
    const { values } = resolveValues(estoque, { Modelo: "onix" }, { phone: null, contactName: null, facts: {} });
    const out = JSON.parse(shapeResponse(estoque, { json, text: "" }, values));
    expect(out.encontrados).toBe(2);
    expect(out.itens.map((i: { Codigo: number }) => i.Codigo)).toEqual([1, 2]);
    expect(out.itens[0]).toEqual({ Codigo: 1, Modelo: "ÔNIX LT", Preco: 68900 });
  });

  it("sem o filtro do agente, só o fixo vale", () => {
    const { values } = resolveValues(estoque, {}, { phone: null, contactName: null, facts: {} });
    const out = JSON.parse(shapeResponse(estoque, { json, text: "" }, values));
    expect(out.encontrados).toBe(3);
    expect(out.mostrando).toBe(2);
  });

  it("mídias dos itens filtrados, só http(s), até o máximo", () => {
    const { values } = resolveValues(estoque, { Modelo: "onix" }, { phone: null, contactName: null, facts: {} });
    const media = responseMedia(estoque, json, values);
    expect(media.map((m) => m.url)).toEqual(["https://f.com/1a.jpg", "https://f.com/1b.jpg", "https://f.com/2a.jpg"]);
    expect(media[0]!.mime).toBe("image/jpeg");
  });

  it("matchFilter: contém, igual, maior e menor", () => {
    expect(matchFilter("Automático", "automatico", "contains")).toBe(true);
    expect(matchFilter("Prata", "prat", "equals")).toBe(false);
    expect(matchFilter("R$ 68.900,00", 60000, "gte")).toBe(true);
    expect(matchFilter(2019, "2020", "lte")).toBe(true);
    expect(matchFilter(["Preto", "Prata"], "prata", "equals")).toBe(true);
  });
});

describe("login OAuth", () => {
  const oauth = { ...base, auth: { type: "oauth2", token_url: "https://api.loja.com/oauth/token", grant: "password" } };

  it("pede o endereço do token", () => {
    expect(ExternalApi.safeParse({ ...base, auth: { type: "oauth2" } }).success).toBe(false);
    expect(ExternalApi.safeParse(oauth).success).toBe(true);
  });

  it("as credenciais são um JSON no cofre; o token vai como Bearer mascarado", () => {
    expect(parseOAuthSecret('{"username":"loja","password":"x"}')).toMatchObject({ username: "loja", password: "x", client_id: "" });
    expect(parseOAuthSecret("chave-simples")).toBeNull();
    const api = ExternalApi.parse(oauth);
    const { values } = resolveValues(api, { numero: "7" }, { phone: null, contactName: null, facts: {} });
    const req = buildRequest(api, values, "token-abcdefgh1234");
    expect(req.headers.authorization).toBe("Bearer token-abcdefgh1234");
    expect(req.preview.headers.Authorization).toBe("Bearer ••••1234");
  });
});
