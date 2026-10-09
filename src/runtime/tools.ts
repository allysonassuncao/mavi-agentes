import type { ToolDef } from "../llm/client.js";
import type { Retrieved } from "../knowledge/search.js";
import type { AgentSpec } from "../spec/agent.js";

/**
 * Ferramentas embutidas (Fase 1). As configuráveis (CRM, agenda, APIs) entram
 * nas próximas fases pelo mesmo registro.
 */

export const REPLY_TOOL = "responder";

export function builtinTools(spec: AgentSpec): ToolDef[] {
  const tools: ToolDef[] = [
    {
      type: "function",
      function: {
        name: REPLY_TOOL,
        description:
          "Envia a resposta ao lead. Sempre a última ação. Cada item de `mensagens` vira uma mensagem separada no WhatsApp. Use `mensagens` vazio só quando não houver nada a dizer.",
        parameters: {
          type: "object",
          properties: {
            mensagens: {
              type: "array",
              maxItems: spec.output.max_messages,
              items: {
                type: "object",
                properties: {
                  texto: { type: "string", description: "Texto da mensagem." },
                  midias: { type: "array", items: { type: "string" }, description: "Códigos de mídia do conhecimento (ex.: M2) a enviar junto." },
                },
                required: ["texto"],
              },
            },
            motivo_silencio: { type: "string", description: "Só quando `mensagens` estiver vazio: por que não responder." },
          },
          required: ["mensagens"],
        },
      },
    },
  ];

  if (spec.knowledge.enabled && spec.knowledge.search_tool) {
    tools.push({
      type: "function",
      function: {
        name: "buscar_conhecimento",
        description:
          "Pesquisa no conhecimento da empresa (perguntas frequentes, produtos e preços, documentos, mídias, exemplos). Use quando os trechos recebidos não bastarem.",
        parameters: {
          type: "object",
          properties: {
            consulta: { type: "string", description: "O que procurar, em palavras simples." },
            tipo: {
              type: "string",
              enum: ["faq", "product", "document", "media", "example", "text"],
              description: "Opcional: limitar a um tipo (ex.: media para achar uma imagem/vídeo para enviar).",
            },
          },
          required: ["consulta"],
        },
      },
    });
  }

  if (spec.memory.contact_fields.length) {
    tools.push({
      type: "function",
      function: {
        name: "registrar_dados_do_contato",
        description: "Guarda dados que o lead informou, para não perguntar de novo.",
        parameters: {
          type: "object",
          properties: {
            dados: {
              type: "object",
              description: `Campos informados. Use estes nomes: ${spec.memory.contact_fields.join(", ")}.`,
              additionalProperties: { type: "string" },
            },
          },
          required: ["dados"],
        },
      },
    });
  }

  if (spec.handoff.enabled) {
    tools.push({
      type: "function",
      function: {
        name: "transferir_para_humano",
        description: "Passa a conversa para uma pessoa da equipe e desliga você nesta conversa. Depois, responda avisando o lead.",
        parameters: {
          type: "object",
          properties: { motivo: { type: "string", description: "Por que transferir (fica numa nota privada para a equipe)." } },
          required: ["motivo"],
        },
      },
    });
  }
  return tools;
}

/** Códigos curtos para o modelo citar trechos e mídias (K1, M1…), válidos na vez. */
export class RefRegistry {
  private byRef = new Map<string, Retrieved>();
  private byChunk = new Map<string, string>();
  private k = 0;
  private m = 0;

  add(r: Retrieved): string {
    const existing = this.byChunk.get(r.chunk_id);
    if (existing) return existing;
    const ref = r.kind === "media" ? `M${++this.m}` : `K${++this.k}`;
    this.byRef.set(ref, r);
    this.byChunk.set(r.chunk_id, ref);
    return ref;
  }
  get(ref: string) {
    return this.byRef.get(ref.trim().toUpperCase());
  }
  all() {
    return [...this.byRef.entries()].map(([ref, r]) => ({ ref, r }));
  }
}

export function formatResults(reg: RefRegistry, results: Retrieved[]): string {
  if (!results.length) return "Nada encontrado no conhecimento para essa consulta.";
  return results
    .map((r) => {
      const ref = reg.add(r);
      return `[${ref}] (${r.kind}) ${r.title ? `${r.title}: ` : ""}${r.content}`;
    })
    .join("\n");
}
