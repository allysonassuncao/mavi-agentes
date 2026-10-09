import { config } from "../config.js";
import { extractFile, kindOf } from "../knowledge/extract.js";
import { chat, transcribe, type Usage, emptyUsage } from "../llm/client.js";
import { fetchPublic } from "../net.js";
import type { AgentSpec } from "../spec/agent.js";

/**
 * Transforma a mídia recebida em texto para o agente: áudio → transcrição,
 * imagem → descrição, documento → texto. Vídeo só é registrado.
 */

export type MediaResult = { text: string; description: string; usage: Usage; error?: string };

const MAX_MEDIA = 25 * 1024 * 1024;

export async function understandMedia(spec: AgentSpec, contentType: string, url: string, caption: string): Promise<MediaResult> {
  const usage = emptyUsage();
  try {
    if (contentType === "ptt" || contentType === "audio") {
      if (!spec.media.audio) return { text: "[o lead enviou um áudio]", description: "", usage };
      const file = await fetchPublic(url, { maxBytes: MAX_MEDIA, timeoutMs: 60_000 });
      const ext = file.mime.includes("mpeg") ? "mp3" : file.mime.includes("mp4") ? "m4a" : "ogg";
      const transcript = await transcribe(new Blob([new Uint8Array(file.bytes)], { type: file.mime || "audio/ogg" }), `audio.${ext}`);
      return { text: `[áudio do lead] ${transcript || "(sem fala reconhecível)"}`, description: transcript, usage };
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
      return { text: `[imagem do lead] ${d}${caption ? `\nLegenda: ${caption}` : ""}`, description: d, usage: r.usage };
    }
    if (contentType === "document") {
      if (!spec.media.documents) return { text: `[o lead enviou um documento]${caption ? ` ${caption}` : ""}`, description: "", usage };
      const file = await fetchPublic(url, { maxBytes: MAX_MEDIA, timeoutMs: 60_000 });
      const name = new URL(file.finalUrl).pathname;
      if (!kindOf(file.mime, name)) return { text: `[o lead enviou um arquivo (${file.mime || "tipo desconhecido"}) que não consigo ler]`, description: "", usage };
      const t = (await extractFile(file.bytes, file.mime, name)).slice(0, 8000);
      return { text: `[documento do lead]${caption ? ` ${caption}` : ""}\n${t}`, description: t.slice(0, 500), usage };
    }
    if (contentType === "video") return { text: `[o lead enviou um vídeo]${caption ? ` ${caption}` : ""}`, description: "", usage };
    return { text: caption, description: "", usage };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { text: `[o lead enviou uma mídia (${contentType}) que não consegui abrir]${caption ? ` ${caption}` : ""}`, description: "", usage, error };
  }
}
