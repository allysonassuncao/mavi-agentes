import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { newToken, sha256 } from "../../crypto.js";
import { db } from "../../db.js";
import { log } from "../../log.js";
import { redis } from "../../redis.js";
import { publishedSpec } from "../../runtime/turn.js";
import { chatPage, LOADER_JS } from "../../webchat/assets.js";
import { domainAllowed, frameAncestors, newWebchatKey, publicConfig, WebchatConfig } from "../../webchat/config.js";
import { createWebchatInbox, inboxByKey, listWebchatInboxes, updateWebchatInbox, webchatInbox, type WebchatInbox } from "../../webchat/makecrm.js";
import { history, identify, openSession, poll, sessionFor, visitorSend, whatsappLink, WebchatError, type Session } from "../../webchat/service.js";
import { HttpError, parseBody } from "../http.js";
import { loadAgent } from "./agents.js";

/**
 * Chat do site. Rotas públicas (/w/…): o script do site, a página do chat e o
 * que ela chama (sessão, mensagens, identificação, WhatsApp), com limite de
 * uso por visitante, por endereço e por caixa. Rotas de administração: criar e
 * mudar o chat de um agente (a caixa fica no MakeCRM).
 */

const base = () => config().PUBLIC_BASE_URL.replace(/\/+$/, "");

/** Conta um uso; true quando passou do limite na janela. */
async function limited(key: string, max: number, seconds: number): Promise<boolean> {
  try {
    const k = `wc:rl:${key}`;
    const n = await redis().incr(k);
    if (n === 1) await redis().expire(k, seconds);
    return n > max;
  } catch {
    return false;
  }
}

type Ctx = { inbox: WebchatInbox & { config: NonNullable<WebchatInbox["config"]> }; host: string | null };

async function widget(req: FastifyRequest): Promise<Ctx> {
  const { key } = req.params as { key: string };
  if (!/^wc_[A-Za-z0-9]{20,40}$/.test(key)) throw new WebchatError(404, "Chat não encontrado.");
  const inbox = await inboxByKey(key);
  if (!inbox?.config) throw new WebchatError(404, "Chat não encontrado.");
  if (!inbox.status) throw new WebchatError(410, "Este chat está desligado.");
  const host = (req.headers["x-host"] as string | undefined) || ((req.query as Record<string, string>).host ?? null) || null;
  if (host && !domainAllowed(inbox.config.domains, host)) throw new WebchatError(403, "Este site não está liberado para o chat.");
  return { inbox: inbox as Ctx["inbox"], host };
}

function visitorOf(req: FastifyRequest): string {
  return String(req.headers["x-visitor"] ?? "").trim();
}

async function session(req: FastifyRequest, ctx: Ctx): Promise<Session> {
  const s = await sessionFor(ctx.inbox, visitorOf(req));
  if (!s) throw new WebchatError(401, "Sessão expirada: recarregue a página.");
  return s;
}

const fail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof WebchatError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message, details: e.details });
  log.error({ err: e instanceof Error ? e.message : String(e) }, "webchat: erro");
  return reply.code(500).send({ error: "O chat não respondeu. Tente de novo." });
};

async function agentOn(inboxId: string): Promise<boolean> {
  const [b] = await db()<{ agent_id: string }[]>`
    select agent_id from public.bindings where inbox_id = ${inboxId} and removed_at is null and enabled and channel = 'webchat'`;
  return !!b && !!(await publishedSpec(b.agent_id).catch(() => null));
}

export async function webchatPublicRoutes(app: FastifyInstance) {
  app.get("/w/widget.js", async (_req, reply) =>
    reply.header("content-type", "application/javascript; charset=utf-8").header("cache-control", "public, max-age=300").header("access-control-allow-origin", "*").send(LOADER_JS),
  );

  app.get("/w/:key/config", async (req, reply) => {
    try {
      const ctx = await widget(req);
      return reply.header("access-control-allow-origin", "*").header("cache-control", "no-store").send(publicConfig(ctx.inbox.config, { agent: await agentOn(ctx.inbox.id) }));
    } catch (e) {
      reply.header("access-control-allow-origin", "*");
      return fail(reply, e);
    }
  });

  /** A página do chat: embutida (quadro no site) ou em tela cheia (link). */
  app.get("/w/:key", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const embed = q.embed === "1";
    try {
      const ctx = await widget(req);
      const html = chatPage({
        key: ctx.inbox.config.key,
        title: ctx.inbox.config.title,
        color: ctx.inbox.config.color,
        embed,
        host: embed ? (q.host ?? "") : "",
        page: (q.page ?? "").slice(0, 1500),
        referrer: (q.ref ?? "").slice(0, 500),
      });
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("content-security-policy", `frame-ancestors ${embed ? frameAncestors(ctx.inbox.config.domains) : "'none'"}; default-src 'self'; img-src * data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'`)
        .header("referrer-policy", "strict-origin-when-cross-origin")
        .send(html);
    } catch (e) {
      const msg = e instanceof WebchatError ? e.message : "O chat não está disponível agora.";
      return reply
        .code(e instanceof WebchatError ? e.status : 500)
        .header("content-type", "text/html; charset=utf-8")
        .send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;color:#555;display:grid;place-items:center;height:90vh">${msg}</body>`);
    }
  });

  app.post("/w/:key/session", async (req, reply) => {
    try {
      const ctx = await widget(req);
      if (await limited(`ip:${req.ip}:session`, 60, 60)) throw new WebchatError(429, "Muitas tentativas. Espere um pouco.");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const page = typeof body.page_url === "string" && /^https?:\/\//.test(body.page_url) ? body.page_url.slice(0, 1500) : null;
      const s = await openSession(ctx.inbox, visitorOf(req), { pageUrl: page, referrer: typeof body.referrer === "string" ? body.referrer.slice(0, 500) || null : null });
      return {
        config: publicConfig(ctx.inbox.config, { agent: await agentOn(ctx.inbox.id) }),
        visitor: { name: s.contact_name, identified: !!(s.contact_name && s.phone) },
        messages: await history(s),
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/w/:key/identify", async (req, reply) => {
    try {
      const ctx = await widget(req);
      const s = await session(req, ctx);
      if (await limited(`v:${s.id}:identify`, 10, 3600)) throw new WebchatError(429, "Muitas tentativas. Espere um pouco.");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const next = await identify(ctx.inbox, s, { name: body.name, phone: body.phone, email: body.email }, { requirePhone: ctx.inbox.config.identify === "form" });
      return { visitor: { name: next.contact_name, identified: !!(next.contact_name && next.phone) } };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/w/:key/messages", async (req, reply) => {
    try {
      const ctx = await widget(req);
      const s = await session(req, ctx);
      if (ctx.inbox.config.identify === "form" && !(s.contact_name && s.phone) && !s.makecrm_conversation_id)
        throw new WebchatError(400, "Preencha nome e WhatsApp para começar.");
      if (
        (await limited(`v:${s.id}:min`, 15, 60)) ||
        (await limited(`v:${s.id}:day`, 300, 86_400)) ||
        (await limited(`ip:${req.ip}:msg`, 40, 60)) ||
        (await limited(`inbox:${ctx.inbox.id}:hour`, 1500, 3600))
      )
        throw new WebchatError(429, "Muitas mensagens seguidas. Espere um pouco.");
      const text = String(((req.body ?? {}) as Record<string, unknown>).text ?? "");
      return await visitorSend(ctx.inbox, s, text);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get("/w/:key/messages", async (req, reply) => {
    try {
      const ctx = await widget(req);
      const s = await session(req, ctx);
      if (await limited(`v:${s.id}:poll`, 120, 60)) throw new WebchatError(429, "Muitas consultas.");
      const q = req.query as Record<string, string>;
      const after = Math.max(Number(q.after) || 0, 0);
      const wait = Math.min(Math.max(Number(q.wait) || 0, 0), 25) * 1000;
      return await poll(s, after, wait);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post("/w/:key/whatsapp", async (req, reply) => {
    try {
      const ctx = await widget(req);
      const s = await session(req, ctx);
      return { url: await whatsappLink(ctx.inbox, s) };
    } catch (e) {
      return fail(reply, e);
    }
  });
}

// ---------------------------------------------------------------- administração

/** O que dá para configurar (a chave é do motor: gerada na criação, não muda). */
const EditableConfig = WebchatConfig.omit({ key: true });

function snippets(key: string) {
  const src = `${base()}/w/widget.js`;
  return {
    link: `${base()}/w/${key}`,
    bubble: `<script src="${src}" data-key="${key}" async></script>`,
    inline: `<div id="mavi-chat"></div>\n<script src="${src}" data-key="${key}" data-mode="inline" data-target="#mavi-chat" data-height="600px" async></script>`,
  };
}

async function bindingsOf(inboxIds: string[]) {
  if (!inboxIds.length) return new Map<string, { id: string; agent_id: string; agent_name: string; enabled: boolean }>();
  const rows = await db()<{ id: string; inbox_id: string; agent_id: string; agent_name: string; enabled: boolean }[]>`
    select b.id, b.inbox_id, b.agent_id, a.name as agent_name, b.enabled from public.bindings b join public.agents a on a.id = b.agent_id
    where b.inbox_id in ${db()(inboxIds)} and b.removed_at is null`;
  return new Map(rows.map((r) => [r.inbox_id, r]));
}

export async function webchatAdminRoutes(app: FastifyInstance) {
  /** Os chats do site da empresa do agente (no MakeCRM), com quem está ligado a cada um. */
  app.get("/v1/agents/:id/webchats", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const inboxes = await listWebchatInboxes(a.company_id);
    const bound = await bindingsOf(inboxes.map((i) => i.id));
    return {
      webchats: inboxes.map((i) => ({
        inbox_id: i.id,
        name: i.name,
        status: i.status,
        config: i.config,
        binding: bound.get(i.id) ?? null,
        ...(i.config ? { snippets: snippets(i.config.key) } : {}),
      })),
    };
  });

  /** Cria a caixa "Chat do site" no MakeCRM e liga a este agente. */
  app.post("/v1/agents/:id/webchats", async (req, reply) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(z.object({ name: z.string().trim().min(2).max(80), config: EditableConfig, created_by: z.string().max(200).optional() }), req.body);
    const cfg = { ...body.config, key: newWebchatKey() };
    const inbox = await createWebchatInbox(a.company_id, body.name, cfg);
    const [binding] = await db()`
      insert into public.bindings (agent_id, company_id, inbox_id, inbox_name, token_hash, created_by, channel)
      values (${a.id}, ${a.company_id}, ${inbox.id}, ${inbox.name}, ${sha256(newToken("wc_"))}, ${body.created_by ?? req.client!.name}, 'webchat')
      returning id, inbox_id, inbox_name, enabled, created_at, channel`;
    return reply.code(201).send({ inbox_id: inbox.id, name: inbox.name, config: cfg, binding, snippets: snippets(cfg.key) });
  });

  app.patch("/v1/agents/:id/webchats/:inbox", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const inbox = await webchatInbox((req.params as { inbox: string }).inbox);
    if (!inbox || inbox.company_id !== a.company_id) throw new HttpError(404, "Chat do site não encontrado nesta empresa.");
    const body = parseBody(z.object({ name: z.string().trim().min(2).max(80).optional(), config: EditableConfig.optional(), status: z.boolean().optional() }), req.body);
    // Caixa criada no MakeCRM sem configuração ainda: ganha a chave agora.
    const cfg = body.config ? { ...body.config, key: inbox.config?.key ?? newWebchatKey() } : undefined;
    await updateWebchatInbox(inbox, { name: body.name, config: cfg, status: body.status });
    const key = cfg?.key ?? inbox.config?.key;
    return { ok: true, ...(key ? { snippets: snippets(key) } : {}) };
  });
}
