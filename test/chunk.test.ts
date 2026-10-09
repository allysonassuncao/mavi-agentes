import { describe, expect, it } from "vitest";
import { chunkItem, splitText } from "../src/knowledge/chunk.js";

describe("trechos", () => {
  it("FAQ e produto viram um trecho só", () => {
    expect(chunkItem({ kind: "faq", title: "", body: "", data: { question: "Tem estacionamento?", answer: "Sim, gratuito." } })).toEqual([
      { ord: 0, title: "Tem estacionamento?", content: "Sim, gratuito.", meta: {} },
    ]);
    const p = chunkItem({ kind: "product", title: "", body: "", data: { name: "Camiseta", price: "R$ 50", attributes: { tamanho: "P-GG" } } });
    expect(p).toHaveLength(1);
    expect(p[0]!.content).toContain("Preço: R$ 50");
    expect(p[0]!.content).toContain("tamanho: P-GG");
  });

  it("mídia guarda o caminho do arquivo para enviar depois", () => {
    const m = chunkItem({ kind: "media", title: "Case", body: "", data: { storage_path: "a/b/c.png", mime: "image/png", description: "Case de reforma" } });
    expect(m[0]!.meta.storage_path).toBe("a/b/c.png");
    expect(m[0]!.content).toBe("Case de reforma");
  });

  it("texto longo é dividido sem perder conteúdo e respeitando o tamanho", () => {
    const para = (n: number) => `Parágrafo ${n}. ` + "Frase de exemplo com algumas palavras. ".repeat(12);
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n");
    const chunks = splitText(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000);
    for (let i = 0; i < 12; i++) expect(chunks.some((c) => c.includes(`Parágrafo ${i}.`))).toBe(true);
  });

  it("texto curto fica inteiro", () => {
    expect(splitText("  oi  ")).toEqual(["oi"]);
    expect(splitText("")).toEqual([]);
  });
});
