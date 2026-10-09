import { rest } from "../makecrm/client.js";

/** Oportunidade do MakeCRM ligada à conversa. */
export type Deal = {
  id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  user_id: string | null;
  sdr_id: string | null;
  closer_id: string | null;
  name: string | null;
};

const COLS = "id,pipeline_id,stage_id,contact_id,user_id,sdr_id,closer_id,name,status";

/** As oportunidades ativas (status 1) da conversa: pela ligação conversa↔oportunidade e pela coluna da oportunidade. */
export async function activeDeals(conversationId: string): Promise<Deal[]> {
  const enc = encodeURIComponent(conversationId);
  const [linked, direct] = await Promise.all([
    rest<{ deal_id: string }[]>(`pipeline_deal_inbox_conversations?select=deal_id&conversation_id=eq.${enc}`),
    rest<(Deal & { status: number })[]>(`pipeline_deals?select=${COLS}&conversation_id=eq.${enc}&status=eq.1`),
  ]);
  const ids = [...new Set(linked.map((l) => l.deal_id))].filter((id) => !direct.some((d) => d.id === id));
  const more = ids.length
    ? await rest<(Deal & { status: number })[]>(`pipeline_deals?select=${COLS}&id=in.(${ids.join(",")})&status=eq.1`)
    : [];
  return [...direct, ...more].map(({ status: _s, ...d }) => d);
}

export async function addStory(dealId: string, userId: string | null, content: string) {
  await rest("pipeline_deal_stories", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ deal_id: dealId, user_id: userId, content }),
  });
}

/** Nota privada na conversa do MakeCRM (só a equipe vê). */
export async function addPrivateNote(conversationId: string, inboxId: string, content: string) {
  await rest("inbox_messages", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ conversation_id: conversationId, inbox_id: inboxId, message_type: "outcoming", content, content_type: "text", private: true }),
  });
}

const nameCache = new Map<string, string>();
export async function userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x && !nameCache.has(x)))];
  if (want.length) {
    const rows = await rest<{ id: string; name: string | null }[]>(`users?select=id,name&id=in.(${want.join(",")})`);
    for (const r of rows) nameCache.set(r.id, r.name ?? "");
  }
  return new Map(ids.filter((x): x is string => !!x).map((id) => [id, nameCache.get(id) ?? ""]));
}
