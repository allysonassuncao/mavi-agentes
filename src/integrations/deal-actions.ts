import { config } from "../config.js";
import { db } from "../db.js";
import { log } from "../log.js";
import { rest } from "../makecrm/client.js";
import type { ActivityAssigneeT } from "../spec/integrations.js";
import { cancelEvent, googleToken } from "./calendar.js";
import { addStory, type Deal } from "./deals.js";
import type { IntegrationCtx } from "./index.js";
import { pickUser } from "./rotation.js";
import { spYmd } from "./time.js";

/**
 * Ações na oportunidade do MakeCRM feitas pelo agente, do mesmo jeito que a
 * tela do MakeCRM faz (makecrm-dyad: useMarkDealAsLost, useMarkDealAsWon,
 * useCreateQuote, useCreateActivity, useCreateStory): as mesmas tabelas, o
 * mesmo texto no histórico, os mesmos resumos em pipeline_deals e os mesmos
 * webhooks de automação. Status da oportunidade: 0 perdida, 1 aberta, 2 ganha.
 */

type DealFull = Deal & { status: number; source_id: string | null; campaign_id: string | null; updated_at: string | null };
const FULL = "id,pipeline_id,stage_id,contact_id,user_id,sdr_id,closer_id,name,status,source_id,campaign_id,updated_at";

/** As oportunidades da conversa, a mais recente primeiro (abertas; com closed, também as fechadas). */
export async function conversationDeals(conversationId: string, opts: { closed?: boolean } = {}): Promise<DealFull[]> {
  const enc = encodeURIComponent(conversationId);
  const linked = await rest<{ deal_id: string }[]>(`pipeline_deal_inbox_conversations?select=deal_id&conversation_id=eq.${enc}`);
  const ids = [...new Set(linked.map((l) => l.deal_id))];
  const status = opts.closed ? "" : "&status=eq.1";
  const [direct, more] = await Promise.all([
    rest<DealFull[]>(`pipeline_deals?select=${FULL}&conversation_id=eq.${enc}${status}`),
    ids.length ? rest<DealFull[]>(`pipeline_deals?select=${FULL}&id=in.(${ids.join(",")})${status}`) : Promise.resolve([] as DealFull[]),
  ]);
  const all = new Map([...direct, ...more].map((d) => [d.id, d]));
  return [...all.values()].sort((a, b) => a.status === 1 && b.status !== 1 ? -1 : b.status === 1 && a.status !== 1 ? 1 : String(b.updated_at).localeCompare(String(a.updated_at)));
}

/** A oportunidade aberta principal (a atualizada por último). */
export async function mainDeal(conversationId: string): Promise<DealFull | null> {
  return (await conversationDeals(conversationId)).find((d) => d.status === 1) ?? null;
}

const money = (value: number, code: string) => {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: code || "BRL" }).format(value);
  } catch {
    return `${code} ${value.toFixed(2)}`;
  }
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function currencies(): Promise<Map<number, { code: string; symbol: string }>> {
  const rows = await rest<{ id: number; code: string; symbol: string }[]>("currencys?select=id,code,symbol");
  return new Map(rows.map((c) => [c.id, { code: c.code, symbol: c.symbol }]));
}

async function webhook(url: string, payload: Record<string, unknown>, what: string) {
  if (!url) return;
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) }).catch((e) =>
    log.warn({ err: String(e) }, `${what}: webhook do MakeCRM não respondeu`),
  );
}

const automationPayload = (ctx: IntegrationCtx, d: DealFull) => ({
  deal_id: d.id,
  user_id: d.user_id,
  sdr_id: d.sdr_id,
  closer_id: d.closer_id,
  stage_id: d.stage_id,
  company_id: ctx.companyId,
  pipeline_id: d.pipeline_id,
  source_id: d.source_id,
  campaign_id: d.campaign_id,
  contact_id: d.contact_id,
});

// ---------------------------------------------------------------- reuniões

/**
 * Cancela as reuniões futuras das oportunidades: as marcadas pelo agente
 * direto no Google; as marcadas pela equipe pelo mesmo webhook da tela.
 */
export async function cancelDealMeetings(ctx: IntegrationCtx, dealIds: string[], reason: string): Promise<number> {
  if (!dealIds.length) return 0;
  const sql = db();
  const meets = await rest<{ id: string; title: string | null; start: string; end: string; event_id: string | null; user_id: string | null; deal_id: string }[]>(
    `pipeline_deal_meets?select=id,title,start,end,event_id,user_id,deal_id&deal_id=in.(${dealIds.join(",")})&status=eq.true&start=gt.${encodeURIComponent(new Date().toISOString())}`,
  );
  const ours = await sql<{ id: string; event_id: string; host_user_id: string; attendee_email: string | null; guests: string[] }[]>`
    select id, event_id, host_user_id, attendee_email, guests from public.agent_meetings
    where company_id = ${ctx.companyId} and status = 'scheduled' and ends_at > now()
      and (conversation_id = ${ctx.conversationId} or deal_ids && ${dealIds}::text[])`;
  const done = new Set<string>();
  let n = 0;
  for (const m of ours) {
    const token = await googleToken(ctx.companyId, m.host_user_id);
    if (token) await cancelEvent(token, m.event_id, !!m.attendee_email || m.guests.length > 0);
    await rest(`pipeline_deal_meets?event_id=eq.${encodeURIComponent(m.event_id)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({ status: false }),
    }).catch(() => {});
    await sql`update public.agent_meetings set status = 'canceled', updated_at = now() where id = ${m.id}`;
    done.add(m.event_id);
    n++;
  }
  const others = meets.filter((m) => !m.event_id || !done.has(m.event_id));
  if (others.length) {
    const owners = [...new Set(others.map((m) => m.user_id).filter((x): x is string => !!x))];
    const emails = owners.length ? new Map((await rest<{ id: string; email: string | null }[]>(`users?select=id,email&id=in.(${owners.join(",")})`)).map((u) => [u.id, u.email])) : new Map();
    for (const m of others) {
      await webhook(
        config().MAKECRM_MEET_DELETE_URL,
        { user_id: m.user_id, user_email: m.user_id ? emails.get(m.user_id) ?? null : null, summary: m.title, deal_id: m.deal_id, start: m.start, end: m.end, event_id: m.event_id },
        "cancelar reunião",
      );
      n++;
    }
  }
  if (n) for (const d of dealIds) await addStory(d, ctx.maviUserId, `<strong>Reuniões futuras canceladas pela MAVI</strong>${reason ? `<br/>Motivo: ${esc(reason)}` : ""}`).catch(() => {});
  return n;
}

// ---------------------------------------------------------------- perdido

export async function markLost(
  ctx: IntegrationCtx,
  deal: DealFull,
  reasonId: string,
  description: string,
  opts: { cancelMeetings: boolean; completeActivities: boolean },
): Promise<string> {
  const [reason] = await rest<{ id: string; name: string }[]>(`lost_reasons?select=id,name&id=eq.${reasonId}&company_id=eq.${encodeURIComponent(ctx.companyId)}`);
  if (!reason) throw new Error("O motivo de perda não existe mais no MakeCRM.");
  if (opts.cancelMeetings) await cancelDealMeetings(ctx, [deal.id], `oportunidade perdida (${reason.name})`);
  if (opts.completeActivities) {
    const open = await rest<{ id: string }[]>(`pipeline_deal_activities?select=id&deal_id=eq.${deal.id}&status=eq.1`);
    if (open.length) {
      await rest(`pipeline_deal_activities?id=in.(${open.map((a) => a.id).join(",")})`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ status: 2 }),
      });
      await addStory(deal.id, ctx.maviUserId, "Atividades em aberto marcadas como concluídas automaticamente devido à perda da oportunidade.").catch(() => {});
      await syncDealActivities(deal.id);
    }
  }
  await rest("pipeline_deal_losts", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ deal_id: deal.id, reason_id: reason.id, description: description || null }),
  });
  await rest(`pipeline_deals?id=eq.${deal.id}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ status: 0, updated_at: new Date().toISOString() }),
  });
  await addStory(deal.id, ctx.maviUserId, `Oportunidade perdida por ${reason.name}. Observações adicionais: ${description ? esc(description) : "—"} (pela MAVI)`).catch(() => {});
  await webhook(config().MAKECRM_LOST_URL, { ...automationPayload(ctx, deal), lost_reasons_id: reason.id }, "perdido");
  return reason.name;
}

// ---------------------------------------------------------------- orçamento

type QuoteRow = { id: string; quoted_price: number | null; closed_price: number | null; currency: number | null; product: { id: string; name: string } | null };

/** Recalcula os resumos da oportunidade (valor, produtos, orçamentos) como a tela faz. */
async function syncDealQuotes(dealId: string, pick: "quoted" | "closed", only?: QuoteRow[]) {
  const quotes = only ?? (await rest<QuoteRow[]>(`pipeline_deal_quotes?select=id,quoted_price,closed_price,currency,product:products(id,name)&deal_id=eq.${dealId}`));
  const cur = await currencies();
  const products = new Map<string, { id: string; name: string }>();
  const totals = new Map<number, { currency: number; code: string; symbol: string; value: number }>();
  let total = 0;
  const list = quotes.map((q) => {
    const value = Number((pick === "closed" ? q.closed_price ?? q.quoted_price : q.quoted_price) ?? 0);
    total += value;
    if (q.product) products.set(q.product.id, { id: q.product.id, name: q.product.name });
    const c = q.currency != null ? cur.get(q.currency) : undefined;
    if (q.currency != null) {
      const t = totals.get(q.currency) ?? { currency: q.currency, code: c?.code ?? "", symbol: c?.symbol ?? "", value: 0 };
      t.value += value;
      totals.set(q.currency, t);
    }
    return { id: q.id, product_name: q.product?.name ?? "", currency: q.currency, value, code: c?.code ?? "", symbol: c?.symbol ?? "" };
  });
  return { value: total, products_id: [...products.values()], quotes: [{ quotes: list, total: [...totals.values()] }] };
}

export type QuoteProduct = { id: string; name: string; price: number; currency: number | null };

export async function catalogProduct(companyId: string, productId: string): Promise<QuoteProduct | null> {
  const [p] = await rest<{ id: string; name: string; price: number | null; currency: number | null; status: boolean | null }[]>(
    `products?select=id,name,price,currency,status&id=eq.${productId}&company_id=eq.${encodeURIComponent(companyId)}`,
  );
  if (!p || p.status === false) return null;
  return { id: p.id, name: p.name, price: Number(p.price ?? 0), currency: p.currency };
}

export async function createQuote(ctx: IntegrationCtx, deal: DealFull, product: QuoteProduct, price: number, description: string): Promise<string> {
  await rest("pipeline_deal_quotes", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ deal_id: deal.id, product_id: product.id, quoted_price: price, currency: product.currency ?? 1, description: description || null, user_id: ctx.maviUserId }),
  });
  const code = (await currencies()).get(product.currency ?? 1)?.code ?? "BRL";
  const label = money(price, code);
  await addStory(
    deal.id,
    ctx.maviUserId,
    `Orçamento criado para o produto "${esc(product.name)}" com valor negociado de ${label}.${description ? `\nObservações: ${esc(description)}` : ""} (pela MAVI)`,
  ).catch(() => {});
  const summary = await syncDealQuotes(deal.id, "quoted");
  await rest(`pipeline_deals?id=eq.${deal.id}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(summary) });
  return label;
}

// ---------------------------------------------------------------- ganho

/** Dá como ganha com todos os orçamentos da oportunidade, pelo valor orçado. */
export async function markWon(ctx: IntegrationCtx, deal: DealFull, note: string): Promise<{ ok: true; total: string } | { ok: false; reason: string }> {
  const quotes = await rest<QuoteRow[]>(`pipeline_deal_quotes?select=id,quoted_price,closed_price,currency,product:products(id,name)&deal_id=eq.${deal.id}`);
  if (!quotes.length) return { ok: false, reason: "no_quote" };
  const today = spYmd(new Date());
  await rest("pipeline_deal_wons", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(quotes.map((q) => ({ deal_id: deal.id, date: today, quote_id: q.id, user_id: ctx.maviUserId }))),
  });
  const closed = quotes.map((q) => ({ ...q, closed_price: Number(q.closed_price ?? q.quoted_price ?? 0) }));
  const summary = await syncDealQuotes(deal.id, "closed", closed);
  await rest(`pipeline_deals?id=eq.${deal.id}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ status: 2, ...summary, updated_at: new Date().toISOString() }),
  });
  for (const q of closed)
    await rest(`pipeline_deal_quotes?id=eq.${q.id}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ closed_price: q.closed_price }) }).catch(() => {});
  const cur = await currencies();
  const date = today.split("-").reverse().join("/");
  const lines = closed.map((q) => `Orçamento: ${esc(q.product?.name ?? "Desconhecido")} vendido por ${money(q.closed_price, cur.get(q.currency ?? 1)?.code ?? "BRL")} em ${date}.`);
  await addStory(deal.id, ctx.maviUserId, `Oportunidade marcada como GANHA.\n${lines.join(" ")}${note ? `\nObservações: ${esc(note)}` : ""} (pela MAVI)`).catch(() => {});
  await webhook(
    config().MAKECRM_WON_URL,
    {
      ...automationPayload(ctx, deal),
      quotes: closed.map((q) => ({ id: q.id, value: q.closed_price, name: q.product?.name ?? "Desconhecido", currency_code: cur.get(q.currency ?? 1)?.code ?? "BRL", product_id: q.product?.id ?? null })),
    },
    "ganho",
  );
  const totals = summary.quotes[0]!.total.map((t) => money(t.value, t.code)).join(" + ");
  return { ok: true, total: totals || money(summary.value, "BRL") };
}

// ---------------------------------------------------------------- histórico

export async function addNote(ctx: IntegrationCtx, dealIds: string[], title: string, text: string) {
  for (const d of dealIds) await addStory(d, ctx.maviUserId, `<strong>${esc(title)}</strong><br/>${esc(text).replace(/\n/g, "<br/>")}`);
}

// ---------------------------------------------------------------- atividade

const ROLE_COL = { owner: "user_id", sdr: "sdr_id", closer: "closer_id" } as const;

/** Quem fica com a atividade: o papel da oportunidade (senão quem assume, senão o proprietário), fixo ou rodízio. */
export async function activityAssignee(ctx: IntegrationCtx, deal: Deal, a: ActivityAssigneeT, rotationKey: string, simulate = false): Promise<string | null> {
  if (a.mode === "fixed") return a.user_id;
  if (a.mode === "round_robin") return simulate ? (a.users[0]?.user_id ?? null) : await pickUser(ctx.agentId, rotationKey, a.users);
  return deal[ROLE_COL[a.role]] ?? a.user_id ?? deal.user_id ?? ctx.maviUserId;
}

async function syncDealActivities(dealId: string) {
  const rows = await rest<{ id: string; subject: string; status: number; do_in: string | null; created_at: string }[]>(
    `pipeline_deal_activities?select=id,subject,status,do_in,created_at&deal_id=eq.${dealId}&order=created_at.desc`,
  );
  await rest(`pipeline_deals?id=eq.${dealId}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ activities: rows }) }).catch((e) =>
    log.warn({ err: String(e) }, "atividade: resumo da oportunidade não atualizado"),
  );
}

export async function createActivity(
  ctx: IntegrationCtx,
  deal: Deal,
  input: { typeId: string; subject: string; description: string; doIn: Date; userId: string | null },
) {
  await rest("pipeline_deal_activities", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      deal_id: deal.id,
      user_id: input.userId ?? ctx.maviUserId,
      type_id: input.typeId,
      subject: input.subject.slice(0, 200),
      description: input.description ? `${input.description}\n\n(criada pela MAVI)` : "(criada pela MAVI)",
      do_in: input.doIn.toISOString(),
      status: 1,
    }),
  });
  await syncDealActivities(deal.id);
}
