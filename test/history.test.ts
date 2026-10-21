import { beforeEach, describe, expect, it, vi } from "vitest";

// MakeCRM de mentira: cada tabela responde pelo começo do caminho.
const calls: string[] = [];
let route: (path: string) => unknown = () => [];
vi.mock("../src/makecrm/client.js", () => ({
  rest: vi.fn(async (path: string) => {
    calls.push(path);
    return route(path);
  }),
}));
const cache = new Map<string, string>();
vi.mock("../src/redis.js", () => ({
  redis: () => ({ get: async (k: string) => cache.get(k) ?? null, set: async (k: string, v: string) => void cache.set(k, v) }),
}));
vi.mock("../src/log.js", () => ({ log: { warn: () => {} } }));

const { cleanFilters, conversationIds, historyMessage, historyPage, periodBounds } = await import("../src/makecrm/history.js");

const users = new Map([
  ["u1", { id: "u1", name: "Ana", role: 2, is_ia: false }],
  ["ia", { id: "ia", name: "MAVI", role: 4, is_ia: true }],
]);
const msg = (o: Record<string, unknown>) => ({
  message_type: "incoming",
  content: "oi",
  content_type: "text",
  user_id: null,
  sent_by_device: false,
  broadcast_id: null,
  transcription: null,
  attachment_id: null,
  created_at: "2026-10-01T12:00:00Z",
  ...o,
});

beforeEach(() => {
  calls.length = 0;
  cache.clear();
});

describe("os filtros", () => {
  it("confere o período e tira o que não serve", () => {
    expect(cleanFilters({ from: "2026-10-01", to: "2026-09-01" })).toBeNull();
    expect(cleanFilters({ from: "2026-09-01", to: "2026-10-01", tag_ids: [3, "x", 3, -1], user_ids: ["a b", "0000aaaa-1111"], human_only: false })).toEqual({
      inbox_ids: [],
      from: "2026-09-01",
      to: "2026-10-01",
      user_ids: ["0000aaaa-1111"],
      tag_ids: [3],
      stage_ids: [],
      human_only: false,
    });
    // O dia inteiro em Brasília.
    expect(periodBounds({ from: "2026-10-01", to: "2026-10-01" })).toEqual({ start: "2026-10-01T03:00:00.000Z", end: "2026-10-02T03:00:00.000Z" });
  });
});

describe("cada mensagem", () => {
  it("lado, quem mandou e o que fica de fora", () => {
    expect(historyMessage(msg({}), users)).toEqual({ from: "lead", user_name: null, text: "oi", at: "2026-10-01T12:00:00Z" });
    expect(historyMessage(msg({ message_type: "outcoming", user_id: "u1", content: "olá" }), users)).toMatchObject({ from: "team", user_name: "Ana" });
    expect(historyMessage(msg({ message_type: "outcoming", user_id: "ia" }), users)).toMatchObject({ from: "ai" });
    expect(historyMessage(msg({ message_type: "outcoming", sent_by_device: true }), users)).toMatchObject({ from: "team", user_name: null });
    // Fluxo automático, disparo em massa e mensagem vazia: fora.
    expect(historyMessage(msg({ message_type: "outcoming" }), users)).toBeNull();
    expect(historyMessage(msg({ message_type: "outcoming", user_id: "u1", broadcast_id: 9 }), users)).toBeNull();
    expect(historyMessage(msg({ content: "" }), users)).toBeNull();
  });

  it("áudio transcrito vira texto; outras mídias ganham o tipo", () => {
    expect(historyMessage(msg({ content_type: "ptt", content: "", transcription: { status: "done", text: "quanto custa?" } }), users)?.text).toBe("[áudio] quanto custa?");
    expect(historyMessage(msg({ content_type: "audio", content: "", transcription: { status: "pending" } }), users)?.text).toBe("[áudio]");
    expect(historyMessage(msg({ content_type: "image", content: "olha" }), users)?.text).toBe("[imagem] olha");
    expect(historyMessage(msg({ content_type: "application/pdf", content: "" }), users)?.text).toBe("[documento]");
  });
});

describe("a busca", () => {
  const tables = (path: string) => {
    if (path.startsWith("inboxes?select=id&")) return [{ id: "in1" }];
    if (path.startsWith("inbox_conversations?select=id,last")) {
      const offset = Number(path.match(/offset=(\d+)/)?.[1] ?? 0);
      return offset ? [] : [{ id: "c1", last: "2026-10-01T10:00:00Z" }, { id: "c2", last: "2026-10-05T10:00:00Z" }, { id: "c3", last: "2026-10-03T10:00:00Z" }];
    }
    if (path.startsWith("inbox_tags?select=id&")) return [{ id: 7 }];
    if (path.startsWith("inbox_conversation_tags")) return path.includes("offset=0") ? [{ conversation_id: "c1" }, { conversation_id: "c2" }] : [];
    if (path.startsWith("pipeline_deals")) return path.includes("offset=0") ? [{ id: "d1", conversation_id: null }] : [];
    if (path.startsWith("pipeline_deal_inbox_conversations")) return [{ conversation_id: "c2" }];
    return [];
  };

  it("mais recentes primeiro, com etiqueta e etapa, e guarda a lista", async () => {
    route = tables;
    const f = cleanFilters({ from: "2026-09-01", to: "2026-10-10", tag_ids: [7, 8], stage_ids: ["5a9e0000"], user_ids: ["0000aaaa"] })!;
    expect(await conversationIds("co1", f)).toEqual(["c2"]);
    const conv = calls.find((c) => c.startsWith("inbox_conversations"))!;
    expect(conv).toContain("inbox_id=in.(in1)");
    expect(conv).toContain("or=(user_id.in.(0000aaaa),sdr_id.in.(0000aaaa),closer_id.in.(0000aaaa))");
    // A etiqueta 8 não é da empresa: só a 7 entra.
    expect(calls.find((c) => c.startsWith("inbox_conversation_tags"))).toContain("tag_id=in.(7)");
    const before = calls.length;
    expect(await conversationIds("co1", f)).toEqual(["c2"]);
    expect(calls.length).toBe(before);
    route = tables;
    expect(await conversationIds("co1", cleanFilters({ from: "2026-09-01", to: "2026-10-10" })!)).toEqual(["c2", "c3", "c1"]);
  });

  it("caixa de outra empresa não entra", async () => {
    route = tables;
    expect(await conversationIds("co1", cleanFilters({ from: "2026-09-01", to: "2026-10-10", inbox_ids: ["0000ffff"] })!)).toEqual([]);
  });

  it("a página: só atendimento humano e com os dois lados", async () => {
    route = (path) => {
      if (path.startsWith("inbox_conversations?select=id,inbox_id")) return ["c1", "c2", "c3"].map((id) => ({ id, inbox_id: "in1", name: "Maria", identifier: "5511987654321", created_at: "2026-10-01T00:00:00Z" }));
      if (path.startsWith("inboxes?select=id,name")) return [{ id: "in1", name: "Vendas" }];
      if (path.startsWith("users?")) return [...users.values()];
      if (path.includes("conversation_id=eq.c1")) return [msg({}), msg({ message_type: "outcoming", user_id: "u1", content: "olá" })];
      if (path.includes("conversation_id=eq.c2")) return [msg({}), msg({ message_type: "outcoming", user_id: "ia", content: "sou a IA" })];
      if (path.includes("conversation_id=eq.c3")) return [msg({})];
      return [];
    };
    const f = cleanFilters({ from: "2026-09-01", to: "2026-10-10" })!;
    const page = await historyPage("co1", f, ["c1", "c2", "c3"]);
    expect(page.map((c) => c.id)).toEqual(["c1"]);
    expect(page[0]).toMatchObject({ inbox_name: "Vendas", contact_name: "Maria", contact_phone: "5511987654321" });
    expect(calls.find((c) => c.includes("conversation_id=eq.c1"))).toContain("private=not.is.true");
    expect((await historyPage("co1", { ...f, human_only: false }, ["c1", "c2"])).map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});
