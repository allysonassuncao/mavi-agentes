import { createHash } from "node:crypto";
import { rest } from "./client.js";
import { redis } from "../redis.js";
import { log } from "../log.js";

/**
 * O histórico do atendimento no MakeCRM, para o MAVI Tasks importar
 * (Agentes MAVI › Aprender com conversas). Só leitura: a pessoa escolhe as
 * caixas e o período, os atendentes e as etiquetas ou etapas do funil; aqui
 * se acham as conversas e, página a página, as mensagens. Tudo conferido
 * contra a empresa (a chave do MakeCRM passa por cima das regras do banco).
 *
 * As mensagens saem com o lado: "lead" (incoming), "team" (pessoa da equipe
 * ou o celular) e "ai" (usuário de IA: role 4 ou is_ia). Notas internas,
 * disparos em massa e mensagens de fluxo (sem usuário e fora do celular)
 * ficam de fora; áudio transcrito vira texto.
 */

export type HistoryFilters = {
  inbox_ids: string[];
  /** AAAA-MM-DD, em Brasília. */
  from: string;
  to: string;
  /** Conversas em que a pessoa é a dona, o SDR ou o closer. */
  user_ids: string[];
  tag_ids: number[];
  stage_ids: string[];
  /** Só atendimento humano: conversa com mensagem da IA fica de fora. */
  human_only: boolean;
};
export type HistoryMessage = { from: "lead" | "team" | "ai"; user_name: string | null; text: string; at: string };
export type HistoryConversation = {
  id: string;
  inbox_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  started_at: string | null;
  messages: HistoryMessage[];
};

/** O máximo que uma importação recebe. */
export const HISTORY_MAX = 5000;
const PAGE = 1000;
const MESSAGES_PER_CONVERSATION = 400;
const CACHE_SECONDS = 3600;

const enc = encodeURIComponent;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const UUIDISH = /^[0-9a-f-]{8,64}$/i;

/** Os filtros conferidos (o que não for da forma certa sai); null = período inválido. */
export function cleanFilters(raw: unknown): HistoryFilters | null {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(String).filter((x) => UUIDISH.test(x)))].slice(0, 200) : []);
  const from = YMD.test(String(b.from)) ? String(b.from) : "";
  const to = YMD.test(String(b.to)) ? String(b.to) : "";
  if (!from || !to || from > to) return null;
  return {
    inbox_ids: ids(b.inbox_ids),
    from,
    to,
    user_ids: ids(b.user_ids),
    tag_ids: Array.isArray(b.tag_ids) ? [...new Set(b.tag_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100) : [],
    stage_ids: ids(b.stage_ids),
    human_only: b.human_only !== false,
  };
}

/** O começo do dia "from" e o começo do dia seguinte a "to", em Brasília (UTC−3). */
export function periodBounds(f: Pick<HistoryFilters, "from" | "to">) {
  const start = new Date(`${f.from}T03:00:00.000Z`);
  const end = new Date(new Date(`${f.to}T03:00:00.000Z`).getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Todas as linhas de uma consulta, de mil em mil (o PostgREST corta em mil). */
async function all<T>(path: string, max = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < max; offset += PAGE) {
    const rows = await rest<T[]>(`${path}&limit=${PAGE}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const chunked = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** O que dá para escolher: caixas de WhatsApp, pessoas da equipe, etiquetas e funis com etapas. */
export async function historyFilters(companyId: string) {
  const c = enc(companyId);
  const [inboxes, users, tags, pipelines] = await Promise.all([
    rest<{ id: string; name: string; type_id: number }[]>(`inboxes?select=id,name,type_id&company_id=eq.${c}&type_id=in.(1,2)&order=name.asc`),
    rest<{ id: string; name: string | null; email: string | null; role: number; is_ia: boolean | null }[]>(
      `users?select=id,name,email,role,is_ia&company_id=eq.${c}&status=eq.true&order=name.asc`,
    ),
    rest<{ id: number; label: string; color: string | null; status: boolean | null }[]>(`inbox_tags?select=id,label,color,status&company_id=eq.${c}&order=label.asc`),
    rest<{ id: string; name: string }[]>(`pipelines?select=id,name&company_id=eq.${c}&status=eq.true&order=created_at.asc`),
  ]);
  const stages = pipelines.length
    ? await rest<{ id: string; name: string; pipeline_id: string; order: number }[]>(
        `pipeline_stages?select=id,name,pipeline_id,order&pipeline_id=in.(${pipelines.map((p) => p.id).join(",")})&status=eq.true&order=order.asc`,
      )
    : [];
  return {
    inboxes: inboxes.map((i) => ({ id: i.id, name: i.name })),
    users: users.filter((u) => !u.is_ia && u.role !== 4).map((u) => ({ id: u.id, name: u.name ?? u.email ?? "Usuário" })),
    tags: tags.filter((t) => t.status !== false).map((t) => ({ id: t.id, label: t.label, color: t.color })),
    pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, stages: stages.filter((s) => s.pipeline_id === p.id).map((s) => ({ id: s.id, name: s.name })) })),
  };
}

/**
 * As conversas que batem com os filtros, da atividade mais recente para a
 * mais antiga (até HISTORY_MAX): caixa da empresa, conversa com mensagem no
 * período, a pessoa responsável, a etiqueta e a etapa da oportunidade ligada.
 */
export async function findConversations(companyId: string, f: HistoryFilters): Promise<string[]> {
  const c = enc(companyId);
  const own = await rest<{ id: string }[]>(`inboxes?select=id&company_id=eq.${c}&type_id=in.(1,2)`);
  const ownIds = new Set(own.map((i) => i.id));
  const inboxes = f.inbox_ids.length ? f.inbox_ids.filter((i) => ownIds.has(i)) : [...ownIds];
  if (!inboxes.length) return [];
  const { start, end } = periodBounds(f);
  const people = f.user_ids.join(",");
  const rows = await all<{ id: string; last: string | null }>(
    `inbox_conversations?select=id,last:last_message_content->>created_at&inbox_id=in.(${inboxes.join(",")})` +
      `&created_at=lt.${enc(end)}&last_message_content->>created_at=gte.${enc(start)}` +
      (people ? `&or=(user_id.in.(${people}),sdr_id.in.(${people}),closer_id.in.(${people}))` : "") +
      `&order=id.asc`,
  );
  let keep: Set<string> | null = null;
  const narrow = (ids: Iterable<string>) => {
    const next = new Set(ids);
    keep = keep ? new Set([...keep].filter((x) => next.has(x))) : next;
  };
  if (f.tag_ids.length) {
    const okTags = await rest<{ id: number }[]>(`inbox_tags?select=id&company_id=eq.${c}&id=in.(${f.tag_ids.join(",")})`);
    const tagged = okTags.length
      ? await all<{ conversation_id: string }>(`inbox_conversation_tags?select=conversation_id&tag_id=in.(${okTags.map((t) => t.id).join(",")})&order=conversation_id.asc`)
      : [];
    narrow(tagged.map((t) => t.conversation_id));
  }
  if (f.stage_ids.length) {
    const deals = await all<{ id: string; conversation_id: string | null }>(
      `pipeline_deals?select=id,conversation_id&company_id=eq.${c}&stage_id=in.(${f.stage_ids.join(",")})&order=id.asc`,
    );
    const linked: string[] = deals.flatMap((d) => (d.conversation_id ? [d.conversation_id] : []));
    for (const part of chunked(deals.map((d) => d.id), 100)) {
      const r = await rest<{ conversation_id: string }[]>(`pipeline_deal_inbox_conversations?select=conversation_id&deal_id=in.(${part.join(",")})&limit=${PAGE}`);
      linked.push(...r.map((x) => x.conversation_id));
    }
    narrow(linked);
  }
  const kept = keep as Set<string> | null;
  return rows
    .filter((r) => !kept || kept.has(r.id))
    .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""))
    .slice(0, HISTORY_MAX)
    .map((r) => r.id);
}

const cacheKey = (companyId: string, f: HistoryFilters) =>
  `history:${companyId}:${createHash("sha256").update(JSON.stringify(f)).digest("hex").slice(0, 24)}`;

/** A lista da busca guardada por uma hora: as páginas seguintes não refazem a busca. */
export async function conversationIds(companyId: string, f: HistoryFilters): Promise<string[]> {
  const key = cacheKey(companyId, f);
  try {
    const hit = await redis().get(key);
    if (hit) return JSON.parse(hit) as string[];
  } catch (e) {
    log.warn({ err: e }, "history cache read");
  }
  const ids = await findConversations(companyId, f);
  try {
    await redis().set(key, JSON.stringify(ids), "EX", CACHE_SECONDS);
  } catch (e) {
    log.warn({ err: e }, "history cache write");
  }
  return ids;
}

type Row = {
  message_type: string;
  content: string | null;
  content_type: string | null;
  user_id: string | null;
  sent_by_device: boolean | null;
  broadcast_id: unknown;
  transcription: { status?: string; text?: string } | null;
  attachment_id: number | null;
  created_at: string;
};
type User = { id: string; name: string | null; role: number; is_ia: boolean | null };

const MEDIA: Record<string, string> = {
  ptt: "áudio",
  audio: "áudio",
  image: "imagem",
  motion_photo: "imagem",
  video: "vídeo",
  motion_video: "vídeo",
  ptv: "vídeo",
  gif: "gif",
  sticker: "figurinha",
  document: "documento",
  file: "documento",
  contact_share: "contato",
};

/** Uma mensagem do MakeCRM para a importação; null = fica de fora. */
export function historyMessage(m: Row, users: Map<string, User>): HistoryMessage | null {
  if (m.broadcast_id) return null;
  let from: HistoryMessage["from"];
  let userName: string | null = null;
  if (m.message_type === "incoming") from = "lead";
  else if (m.message_type === "outcoming") {
    const u = m.user_id ? users.get(m.user_id) : undefined;
    if (u) {
      from = u.is_ia || u.role === 4 ? "ai" : "team";
      userName = u.name;
    } else if (m.user_id || m.sent_by_device) from = "team";
    // Sem usuário e fora do celular: mensagem de fluxo (menu, boas-vindas automáticas).
    else return null;
  } else return null;
  const type = (m.content_type ?? "text").toLowerCase();
  const kind = MEDIA[type] ?? (type.startsWith("application") ? "documento" : type.includes("sticker") ? "figurinha" : null);
  const said = (m.content ?? "").trim();
  let text = said;
  if (kind === "áudio") {
    const t = m.transcription?.status === "done" ? (m.transcription.text ?? "").trim() : "";
    text = t ? `[áudio] ${t}` : "[áudio]";
  } else if (kind) text = said ? `[${kind}] ${said}` : `[${kind}]`;
  if (!text) return null;
  return { from, user_name: userName, text: text.slice(0, 4000), at: m.created_at };
}

/** Uma página de conversas com as mensagens do período. */
export async function historyPage(
  companyId: string,
  f: HistoryFilters,
  ids: string[],
): Promise<HistoryConversation[]> {
  if (!ids.length) return [];
  const c = enc(companyId);
  const { start, end } = periodBounds(f);
  const [convs, inboxes, users] = await Promise.all([
    rest<{ id: string; inbox_id: string; name: string | null; identifier: string | null; created_at: string }[]>(
      `inbox_conversations?select=id,inbox_id,name,identifier,created_at&id=in.(${ids.join(",")})`,
    ),
    rest<{ id: string; name: string }[]>(`inboxes?select=id,name&company_id=eq.${c}`),
    rest<User[]>(`users?select=id,name,role,is_ia&company_id=eq.${c}`),
  ]);
  const inboxName = new Map(inboxes.map((i) => [i.id, i.name]));
  const byUser = new Map(users.map((u) => [u.id, u]));
  const byId = new Map(convs.filter((x) => inboxName.has(x.inbox_id)).map((x) => [x.id, x]));
  const out: HistoryConversation[] = [];
  // Seis conversas por vez: cada uma lê pelo índice (conversation_id, created_at).
  for (const part of chunked(ids.filter((id) => byId.has(id)), 6)) {
    const pages = await Promise.all(
      part.map((id) =>
        rest<Row[]>(
          `inbox_messages?select=message_type,content,content_type,user_id,sent_by_device,broadcast_id,transcription,attachment_id,created_at` +
            `&conversation_id=eq.${enc(id)}&private=not.is.true&created_at=gte.${enc(start)}&created_at=lt.${enc(end)}` +
            `&order=created_at.asc&limit=${MESSAGES_PER_CONVERSATION}`,
        ),
      ),
    );
    part.forEach((id, i) => {
      const conv = byId.get(id)!;
      const messages = pages[i]!.map((m) => historyMessage(m, byUser)).filter((m): m is HistoryMessage => !!m);
      if (f.human_only && messages.some((m) => m.from === "ai")) return;
      // Os dois lados: o lead e a empresa (a equipe; sem o filtro, a IA também conta).
      const company = (m: HistoryMessage) => m.from === "team" || (!f.human_only && m.from === "ai");
      if (!messages.some((m) => m.from === "lead") || !messages.some(company)) return;
      out.push({
        id,
        inbox_name: inboxName.get(conv.inbox_id) ?? "",
        contact_name: conv.name,
        contact_phone: conv.identifier,
        started_at: messages[0]?.at ?? conv.created_at,
        messages,
      });
    });
  }
  return out;
}
