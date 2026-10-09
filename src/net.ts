import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Baixa de endereços externos sem deixar alcançar a rede interna (SSRF):
 * só http(s), sem IPs privados/locais, tamanho e tempo limitados.
 */

function privateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateIp(mapped[1]!) : false;
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Endereço inválido.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Só endereços http(s).");
  if (url.username || url.password) throw new Error("Endereço com usuário/senha não é aceito.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateIp)) throw new Error("Endereço interno não é aceito.");
  return url;
}

export async function fetchPublic(raw: string, opts: { maxBytes: number; timeoutMs?: number; accept?: string }) {
  let current = raw;
  for (let hop = 0; hop < 4; hop++) {
    const url = await assertPublicUrl(current);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      headers: { "user-agent": "MAVI-Agentes/1.0", ...(opts.accept ? { accept: opts.accept } : {}) },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Download falhou (${res.status}).`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > opts.maxBytes) throw new Error("Arquivo grande demais.");
    const reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > opts.maxBytes) {
          await reader.cancel();
          throw new Error("Arquivo grande demais.");
        }
        parts.push(value);
      }
    }
    return {
      bytes: Buffer.concat(parts),
      mime: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
      finalUrl: url.toString(),
    };
  }
  throw new Error("Redirecionamentos demais.");
}
