import { config } from "../config.js";

/** Supabase Storage do motor (arquivos e mídias da base de conhecimento). */

function headers(extra: Record<string, string> = {}) {
  const key = config().SUPABASE_SECRET_KEY;
  return { apikey: key, authorization: `Bearer ${key}`, ...extra };
}
const base = () => `${config().SUPABASE_URL.replace(/\/+$/, "")}/storage/v1`;
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

let bucketReady = false;
export async function ensureBucket() {
  if (bucketReady) return;
  const bucket = config().KNOWLEDGE_BUCKET;
  const res = await fetch(`${base()}/bucket/${bucket}`, { headers: headers() });
  if (!res.ok) {
    const created = await fetch(`${base()}/bucket`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 50 * 1024 * 1024 }),
    });
    if (!created.ok && created.status !== 409) throw new Error(`Storage: não criou o bucket (${created.status}): ${await created.text()}`);
  }
  bucketReady = true;
}

export async function putObject(path: string, bytes: Buffer, mime: string) {
  await ensureBucket();
  const res = await fetch(`${base()}/object/${config().KNOWLEDGE_BUCKET}/${encodePath(path)}`, {
    method: "POST",
    headers: headers({ "content-type": mime || "application/octet-stream", "x-upsert": "true" }),
    body: new Uint8Array(bytes),
  });
  if (!res.ok) throw new Error(`Storage: falha ao gravar (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

export async function getObject(path: string): Promise<Buffer> {
  const res = await fetch(`${base()}/object/${config().KNOWLEDGE_BUCKET}/${encodePath(path)}`, { headers: headers() });
  if (!res.ok) throw new Error(`Storage: falha ao ler (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

export async function removeObjects(paths: string[]) {
  if (!paths.length) return;
  await fetch(`${base()}/object/${config().KNOWLEDGE_BUCKET}`, {
    method: "DELETE",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ prefixes: paths }),
  });
}

/** Link temporário (para o MakeCRM baixar e enviar a mídia ao lead). */
export async function signedUrl(path: string, expiresIn = 7 * 24 * 3600): Promise<string> {
  const res = await fetch(`${base()}/object/sign/${config().KNOWLEDGE_BUCKET}/${encodePath(path)}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw new Error(`Storage: falha ao assinar (${res.status}).`);
  const j = (await res.json()) as { signedURL?: string };
  if (!j.signedURL) throw new Error("Storage: link assinado vazio.");
  return `${base()}${j.signedURL}`;
}

/**
 * Link para o navegador enviar o arquivo direto ao Storage (sem passar pelo
 * MAVI Tasks, que tem limite de 4,5 MB por requisição na Vercel). Vale 2 h.
 */
export async function signedUploadUrl(path: string): Promise<string> {
  await ensureBucket();
  const res = await fetch(`${base()}/object/upload/sign/${config().KNOWLEDGE_BUCKET}/${encodePath(path)}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: "{}",
  });
  if (!res.ok) throw new Error(`Storage: falha ao criar link de envio (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { url?: string };
  if (!j.url) throw new Error("Storage: link de envio vazio.");
  return `${base()}${j.url}`;
}

/** O arquivo existe no Storage? (e o tamanho). */
export async function objectInfo(path: string): Promise<{ size: number } | null> {
  const dir = path.split("/").slice(0, -1).join("/");
  const name = path.split("/").pop() ?? "";
  const res = await fetch(`${base()}/object/list/${config().KNOWLEDGE_BUCKET}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ prefix: dir, search: name, limit: 10 }),
  });
  if (!res.ok) return null;
  const list = (await res.json()) as { name: string; metadata?: { size?: number } }[];
  const hit = list.find((o) => o.name === name);
  return hit ? { size: hit.metadata?.size ?? 0 } : null;
}
