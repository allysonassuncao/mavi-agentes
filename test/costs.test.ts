import { describe, expect, it } from "vitest";
import { categoryOf, countryOf, providerOf } from "../src/costs/ledger.js";
import { transcribeCost } from "../src/llm/client.js";

describe("custos", () => {
  it("transcrição: por tokens (gpt-4o) ou por minuto (whisper)", () => {
    const t = transcribeCost("gpt-4o-mini-transcribe", { type: "tokens", input_tokens: 1000, output_tokens: 200, input_token_details: { audio_tokens: 1000, text_tokens: 0 } });
    expect(t.usage.costUsd).toBeCloseTo((1000 * 3 + 200 * 5) / 1e6);
    expect(t.units).toBe(1000);
    const w = transcribeCost("whisper-1", { type: "duration", seconds: 90 });
    expect(w.usage.costUsd).toBeCloseTo(0.009);
    expect(w.units).toBe(90);
    expect(transcribeCost("desconhecido", { type: "duration", seconds: 10 }).usage.costUsd).toBe(0);
    expect(transcribeCost("gpt-4o-mini-transcribe", undefined).usage.costUsd).toBe(0);
  });

  it("país do WhatsApp pelo DDI e categoria do modelo aprovado", () => {
    expect(countryOf("+55 (61) 99401-1303")).toBe("BR");
    expect(countryOf("351912345678")).toBe("PT");
    expect(countryOf("5491112345678")).toBe("AR");
    expect(countryOf("12025550123")).toBe("US");
    expect(countryOf("")).toBe("*");
    expect(categoryOf("MARKETING")).toBe("marketing");
    expect(categoryOf("UTILITY")).toBe("utility");
    expect(categoryOf("AUTHENTICATION")).toBe("authentication");
    expect(categoryOf(null)).toBe("marketing");
  });

  it("provedor pelo modelo", () => {
    expect(providerOf("openrouter:openai/gpt-5.2")).toBe("openrouter");
    expect(providerOf("openai/gpt-5-mini")).toBe("openrouter");
    expect(providerOf("gpt-4o-mini-transcribe")).toBe("openai");
    expect(providerOf(null)).toBeNull();
  });
});
