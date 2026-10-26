import { describe, expect, it } from "vitest";
import { chatPage, LOADER_JS } from "../src/webchat/assets.js";
import { domainAllowed, frameAncestors, newWebchatKey, normalizeEmail, normalizePhone, publicConfig, utmOf, WebchatConfig } from "../src/webchat/config.js";

describe("configuração do chat do site", () => {
  it("completa os padrões e limpa os domínios", () => {
    const c = WebchatConfig.parse({ key: newWebchatKey(), domains: ["https://www.Loja.com.br/contato", "*.loja.com.br"] });
    expect(c.identify).toBe("agent");
    expect(c.domains).toEqual(["www.loja.com.br", "*.loja.com.br"]);
    expect(c.whatsapp).toBeNull();
  });

  it("recusa WhatsApp sem DDI e domínio inválido", () => {
    expect(WebchatConfig.safeParse({ key: newWebchatKey(), whatsapp: { phone: "11999998888" } }).success).toBe(false);
    expect(WebchatConfig.safeParse({ key: newWebchatKey(), domains: ["não é domínio"] }).success).toBe(false);
  });

  it("a configuração pública não mostra domínios nem funil", () => {
    const c = WebchatConfig.parse({ key: newWebchatKey(), domains: ["loja.com.br"], whatsapp: { phone: "5511999998888" } });
    const p = publicConfig(c, { agent: true }) as Record<string, unknown>;
    expect(p.domains).toBeUndefined();
    expect(p.deal).toBeUndefined();
    expect(p.whatsapp).toBe(true);
  });
});

describe("domínios", () => {
  it("sem domínios, qualquer site", () => {
    expect(domainAllowed([], "https://qualquer.com")).toBe(true);
  });
  it("domínio, www e subdomínios com *", () => {
    expect(domainAllowed(["loja.com.br"], "https://www.loja.com.br")).toBe(true);
    expect(domainAllowed(["loja.com.br"], "https://loja.com.br:8443")).toBe(true);
    expect(domainAllowed(["loja.com.br"], "https://blog.loja.com.br")).toBe(false);
    expect(domainAllowed(["*.loja.com.br"], "https://blog.loja.com.br")).toBe(true);
    expect(domainAllowed(["loja.com.br"], "https://loja.com.br.golpe.com")).toBe(false);
    expect(domainAllowed(["loja.com.br"], null)).toBe(false);
  });
  it("frame-ancestors", () => {
    expect(frameAncestors([])).toBe("*");
    expect(frameAncestors(["loja.com.br"])).toContain("https://www.loja.com.br");
  });
});

describe("dados do visitante", () => {
  it("telefone com o 55 e e-mail", () => {
    expect(normalizePhone("(11) 99999-8888")).toBe("5511999998888");
    expect(normalizePhone("+55 11 99999-8888")).toBe("5511999998888");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizeEmail(" Ana@Loja.com ")).toBe("ana@loja.com");
    expect(normalizeEmail("ana@")).toBeNull();
  });
  it("UTMs da página", () => {
    expect(utmOf("https://loja.com/?utm_source=google&utm_campaign=natal&x=1")).toEqual({ utm_source: "google", utm_campaign: "natal" });
    expect(utmOf("não é url")).toEqual({});
  });
});

describe("o que o navegador carrega", () => {
  it("o script do site e o da página são JavaScript válido", () => {
    expect(() => new Function(LOADER_JS)).not.toThrow();
    const html = chatPage({ key: "wc_abcdefghijklmnopqrstu", title: "Fale <conosco>", color: "#123456", embed: true, host: "https://loja.com", page: "", referrer: "" });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(2);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(html).toContain("Fale &lt;conosco&gt;");
    expect(html).toContain("--c:#123456");
  });
});
