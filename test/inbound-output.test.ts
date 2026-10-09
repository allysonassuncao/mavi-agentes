import { describe, expect, it } from "vitest";
import { normalizeInbound } from "../src/runtime/inbound.js";
import { cleanText, normalizeReply } from "../src/runtime/output.js";
import { parseSpec } from "../src/spec/agent.js";

const spec = (() => {
  const r = parseSpec({ persona: { name: "Clara", company: "X" }, instructions: { goal: "y" }, output: { max_messages: 2 } });
  if (!r.ok) throw new Error("spec");
  return r.spec;
})();

describe("entrada do MakeCRM", () => {
  it("normaliza o payload do Go e ignora o token do provedor", () => {
    const r = normalizeInbound({
      provider_token: "segredo",
      phone: "5511999999999",
      name: "Ana",
      content: "Oi, quero saber o preço",
      content_type: "text",
      from_me: false,
      source_id: "ABC",
      company_id: "c1",
      inbox_id: "i1",
      conversation_id: "conv1",
      mavi_user_id: "u4",
      base64: "",
    });
    expect(r).toMatchObject({ companyId: "c1", inboxId: "i1", conversationId: "conv1", text: "Oi, quero saber o preço", mediaUrl: null, sourceId: "ABC", fromMe: false });
    expect(JSON.stringify(r)).not.toContain("segredo");
  });

  it("áudio traz a URL da mídia", () => {
    const r = normalizeInbound({ content_type: "ptt", base64: "https://storage.googleapis.com/x/a.ogg", company_id: "c", inbox_id: "i", conversation_id: "v" });
    expect(r).toMatchObject({ contentType: "ptt", mediaUrl: "https://storage.googleapis.com/x/a.ogg" });
  });

  it("recusa sem ids", () => {
    expect(normalizeInbound({ content: "oi" })).toHaveProperty("error");
  });
});

describe("saída", () => {
  it("limpa Markdown, travessão e ponto final", () => {
    expect(cleanText("**Ótimo** — vamos agendar.", spec)).toBe("*Ótimo*, vamos agendar");
    expect(cleanText("Até logo...", spec)).toBe("Até logo...");
  });

  it("junta o excedente na última mensagem permitida", () => {
    const r = normalizeReply([{ texto: "a" }, { texto: "b" }, { texto: "c", midias: ["M1"] }], spec);
    expect(r).toEqual([
      { text: "a", media: [] },
      { text: "b\n\nc", media: ["M1"] },
    ]);
  });
});
