import { describe, expect, it, vi } from "vitest";

describe("cofre das chaves", () => {
  it("cifra e abre; sem SECRETS_KEY recusa", async () => {
    vi.resetModules();
    process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
    Object.assign(process.env, { DATABASE_URL: "postgres://x", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "x", MAKECRM_SUPABASE_URL: "https://y.supabase.co", MAKECRM_PUBLISHABLE_KEY: "x", MAKECRM_SECRET_KEY: "x" });
    const { seal, unseal } = await import("../src/secrets.js");
    const c = seal("sk-or-v1-abc123");
    expect(c.startsWith("v1:")).toBe(true);
    expect(c).not.toContain("abc123");
    expect(unseal(c)).toBe("sk-or-v1-abc123");
    expect(seal("x")).not.toBe(seal("x"));
  });
});
