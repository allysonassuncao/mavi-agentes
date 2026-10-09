import { config } from "../config.js";
import { extractFile, kindOf } from "../knowledge/extract.js";
import { chat, transcribe, type Usage, emptyUsage } from "../llm/client.js";
import { fetchPublic } from "../net.js";
import type { AgentSpec } from "../spec/agent.js";

/**
 * Transforma a mídia recebida em texto para o agente: áudio → transcrição,
 * imagem → descrição, documento → texto, vídeo → o que é falado nele.
 * Devolve o custo e o modelo para o registro de custos.
 */

export type MediaResult = { text: string; description: string; usage: Usage; units?: number; model?: string; error?: string };

const MAX_MEDIA = 25 * 1024 * 1024;

export async function understandMedia(spec: AgentSpec, contentType: string, url: string, caption: string): Promise<MediaResult> {
  const usage = emptyUsage();
  try {
    if (contentType === "ptt" || contentType === "audio") {
      if (!spec.media.audio) return { text: "[o lead enviou um áudio]", description: "", usage };
      const file = await fetchPublic(url, { maxBytes: MAX_MEDIA, timeoutMs: 60_000 });
      const ext = file.mime.includes("mpeg") ? "mp3" : file.mime.includes("mp4") ? "m4a" : "ogg";
      const t = await transcribe(new Blob([new Uint8Array(file.bytes)], { type: file.mime || "audio/ogg" }), `audio.${ext}`);
      return { text: `[áudio do lead] ${t.text || "(sem fala reconhecível)"}`, description: t.text, usage: t.usage, units: t.units, model: t.model };
    }
    if (contentType === "image" || contentType === "sticker") {
      if (!spec.media.images) return { text: `[o lead enviou uma imagem]${caption ? ` ${caption}` : ""}`, description: "", usage };
      const r = await chat({
        model: config().UTILITY_MODEL,
        maxTokens: 500,
        timeoutMs: 45_000,
        messages: [
          {
            role: "system",
            content:
              "Descreva objetivamente esta imagem enviada por um cliente no WhatsApp, em português, em até 4 frases. Transcreva textos, valores e dados visíveis (documentos, comprovantes, prints). Não invente.",
          },
          { role: "user", content: [{ type: "image_url", image_url: { url } }] },
        ],
      });
      const d = (r.message.content ?? "").trim();
      return { text: `[imagem do lead] ${d}${caption ? `\nLegenda: ${caption}` : ""}`, description: d, usage: r.usage, model: r.model };
    }
    if (contentType === "document") {
      if (!spec.media.documents) return { text: `[o lead enviou um documento]${caption ? ` ${caption}` : ""}`, description: "", usage };
      const file = await fetchPublic(url, { maxBytes: MAX_MEDIA, timeoutMs: 60_000 });
      const name = new URL(file.finalUrl).pathname;
      if (!kindOf(file.mime, name)) return { text: `[o lead enviou um arquivo (${file.mime || "tipo desconhecido"}) que não consigo ler]`, description: "", usage };
      const t = (await extractFile(file.bytes, file.mime, name)).slice(0, 8000);
      return { text: `[documento do lead]${caption ? ` ${caption}` : ""}\n${t}`, description: t.slice(0, 500), usage };
    }
    if (contentType === "video") {
      // O que é falado no vídeo (a transcrição aceita mp4/webm até 25 MB).
      if (!spec.media.audio) return { text: `[o lead enviou um vídeo]${caption ? ` ${caption}` : ""}`, description: "", usage };
      const file = await fetchPublic(url, { maxBytes: MAX_MEDIA, timeoutMs: 90_000 });
      const ext = file.mime.includes("webm") ? "webm" : file.mime.includes("quicktime") ? "mov" : "mp4";
      const t = await transcribe(new Blob([new Uint8Array(file.bytes)], { type: file.mime || "video/mp4" }), `video.${ext}`);
      return {
        text: `[vídeo do lead]${caption ? ` ${caption}` : ""}${t.text ? `\nFala no vídeo: ${t.text}` : " (sem fala reconhecível)"}`,
        description: t.text,
        usage: t.usage,
        units: t.units,
        model: t.model,
      };
    }
    return { text: caption, description: "", usage };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { text: `[o lead enviou uma mídia (${contentType}) que não consegui abrir]${caption ? ` ${caption}` : ""}`, description: "", usage, error };
  }
}
