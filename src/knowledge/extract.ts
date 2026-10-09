import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/** Extrai texto de arquivos da base de conhecimento. */

export const SUPPORTED = ["pdf", "docx", "txt", "md", "csv", "html"] as const;

export function kindOf(mime: string, filename = ""): (typeof SUPPORTED)[number] | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.includes("wordprocessingml") || ext === "docx") return "docx";
  if (mime === "text/html" || ext === "html" || ext === "htm") return "html";
  if (mime === "text/csv" || ext === "csv") return "csv";
  if (mime === "text/markdown" || ext === "md") return "md";
  if (mime.startsWith("text/") || ext === "txt") return "txt";
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
}

export async function extractFile(bytes: Buffer, mime: string, filename: string): Promise<string> {
  const kind = kindOf(mime, filename);
  switch (kind) {
    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: false });
      const pages = Array.isArray(text) ? text : [text];
      return pages
        .map((t, i) => (t.trim() ? `[página ${i + 1}]\n${t.trim()}` : ""))
        .filter(Boolean)
        .join("\n\n");
    }
    case "docx":
      return (await mammoth.extractRawText({ buffer: bytes })).value.trim();
    case "html":
      return htmlToText(bytes.toString("utf8"));
    case "txt":
    case "md":
    case "csv":
      return bytes.toString("utf8").trim();
    default:
      throw new Error(`Tipo de arquivo não suportado (${mime || filename}). Aceitos: ${SUPPORTED.join(", ")}.`);
  }
}
