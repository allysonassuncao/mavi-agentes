import { beforeEach, describe, expect, it, vi } from "vitest";

// Redis de mentira: SET NX EX, TTL e DEL, com o relógio do teste.
const store = new Map<string, { v: string; until: number }>();
let now = 0;
vi.mock("../src/redis.js", () => ({
  redis: () => ({
    set: async (k: string, v: string, _ex: string, seconds: number, _nx: string) => {
      const cur = store.get(k);
      if (cur && cur.until > now) return null;
      store.set(k, { v, until: now + seconds * 1000 });
      return "OK";
    },
    ttl: async (k: string) => {
      const cur = store.get(k);
      return cur && cur.until > now ? Math.ceil((cur.until - now) / 1000) : -2;
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  }),
}));

const { claimRepeat, withRepeat } = await import("../src/integrations/repeat.js");
const { parseSpec } = await import("../src/spec/agent.js");

const uid = "00000000-0000-4000-8000-000000000001";
const base = { persona: { name: "Clara", company: "X" }, instructions: { goal: "y" } };

beforeEach(() => {
  store.clear();
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

describe("repetição das ações", () => {
  it("janela: uma vez a cada X minutos por conversa", async () => {
    const r = { mode: "window" as const, minutes: 60 };
    expect((await claimRepeat("c1", "nt", r)).ok).toBe(true);
    const again = await claimRepeat("c1", "nt", r);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.until!.getTime() - now).toBe(3600_000);
    expect((await claimRepeat("c2", "nt", r)).ok).toBe(true); // outra conversa
    now += 61 * 60_000;
    expect((await claimRepeat("c1", "nt", r)).ok).toBe(true);
  });

  it("sempre: só segura a mesma chamada repetida em segundos; uma vez por conversa: até zerar", async () => {
    expect((await claimRepeat("c1", "nt", { mode: "always", minutes: 60 })).ok).toBe(true);
    now += 31_000;
    expect((await claimRepeat("c1", "nt", { mode: "always", minutes: 60 })).ok).toBe(true);
    expect((await claimRepeat("c1", "mv:r", { mode: "conversation", minutes: 60 })).ok).toBe(true);
    now += 90 * 86_400_000;
    const blocked = await claimRepeat("c1", "mv:r", { mode: "conversation", minutes: 60 });
    expect(blocked).toEqual({ ok: false, until: null });
  });

  it("se a ação falha, libera para tentar de novo; bloqueada não executa", async () => {
    const r = { mode: "window" as const, minutes: 60 };
    await expect(withRepeat("c1", "won", r, "Ganho", async () => Promise.reject(new Error("CRM fora")))).rejects.toThrow("CRM fora");
    const fn = vi.fn(async () => ({ result: "ok" }));
    expect(await withRepeat("c1", "won", r, "Ganho", fn)).toEqual({ result: "ok" });
    const blocked = await withRepeat("c1", "won", r, "Ganho", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(blocked).toMatchObject({ silent: true, result: expect.stringContaining("Ganho já foi feito nesta conversa") });
  });

  it("agentes existentes ficam com uma vez por hora em todas as ações e cenários", () => {
    const r = parseSpec({
      ...base,
      integrations: [
        { type: "team_notify", inbox_id: uid, phones: ["5511999999999"], when: "lead quente" },
        { type: "makecrm_move_deal", rules: [{ id: "q", when: "quando qualificar", pipeline_id: uid, stage_id: uid }] },
        { type: "makecrm_deal_actions", note: { enabled: true } },
      ],
      scenarios: [{ id: "s", name: "Sair", when: "pede para parar" }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const hour = { mode: "window", minutes: 60 };
    for (const i of r.spec.integrations) {
      if (i.type === "makecrm_deal_actions") for (const k of ["lost", "won", "quote", "note", "activity"] as const) expect(i[k].repeat).toEqual(hour);
      else expect((i as { repeat?: unknown }).repeat).toEqual(hour);
    }
    expect(r.spec.scenarios[0]!.repeat).toEqual(hour);
    expect(parseSpec({ ...base, scenarios: [{ id: "s", name: "Sair", when: "pede para parar", repeat: { mode: "window", minutes: 1 } }] }).ok).toBe(false);
  });
});
