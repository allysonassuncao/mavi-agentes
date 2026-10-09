import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { newToken, sha256 } from "../../crypto.js";
import { db } from "../../db.js";
import { connectedUsers } from "../../integrations/calendar.js";
import {
  companyByMakeId,
  listTemplates,
  rest,
  templateBody,
  getInbox,
  getInboxWebhook,
  inboxBlockedByLegacyAgent,
  listInboxes,
  setInboxWebhook,
} from "../../makecrm/client.js";
import { parseSpec, type AgentSpec } from "../../spec/agent.js";
import { canCompany } from "../auth.js";
import { assertUuid, HttpError, notFound, parseBody } from "../http.js";

type AgentRow = {
  id: string;
  company_id: string;
  name: string;
  origin: string;
  external_ref: Record<string, unknown>;
  status: string;
  draft: Record<string, unknown>;
  draft_updated_at: Date;
  draft_updated_by: string | null;
  published_version: number | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function loadAgent(req: FastifyRequest, id: string): Promise<AgentRow> {
  assertUuid(id, "Agente");
  const [a] = await db()<AgentRow[]>`select * from public.agents where id = ${id} and archived_at is null`;
  if (!a || !canCompany(req, a.company_id)) throw notFound("Agente");
  return a;
}

const inboundUrl = (token: string) => `${config().PUBLIC_BASE_URL.replace(/\/+$/, "")}/v1/inbound/makecrm/${token}`;

const CreateAgent = z.object({
  company_id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  origin: z.enum(["mavi_tasks", "makecrm"]).default("mavi_tasks"),
  external_ref: z.record(z.string(), z.unknown()).default({}),
  draft: z.record(z.string(), z.unknown()).default({}),
  created_by: z.string().max(200).optional(),
});

const UpdateAgent = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "paused"]).optional(),
  external_ref: z.record(z.string(), z.unknown()).optional(),
  /** Quanto das conversas a MAVI lê para os insights (vale na hora, sem publicar). */
  insights_sample_percent: z.number().int().min(0).max(100).optional(),
});

const Draft = z.object({
  draft: z.record(z.string(), z.unknown()),
  updated_by: z.string().max(200).optional(),
});

const PricingIn = z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000), cached: z.number().min(0).max(1000).nullable().optional() });
const Publish = z.object({
  note: z.string().max(500).default(""),
  published_by: z.string().max(200).optional(),
  /** Publicar de novo uma versão antiga (voltar). */
  restore_version: z.number().int().min(1).optional(),
  /**
   * Quem constrói pode completar a versão: o modelo padrão (e reserva) quando
   * o rascunho deixa no padrão, e o preço de cada modelo ("<provedor>:<modelo>").
   */
  default_model: z.string().trim().min(1).max(160).optional(),
  default_fallback: z.string().trim().min(1).max(160).optional(),
  pricing: z.record(z.string(), PricingIn).optional(),
});

/** Completa a versão com o padrão e os preços vindos de quem constrói. */
export function withModelDefaults(
  spec: AgentSpec,
  opts: { default_model?: string; default_fallback?: string; pricing?: Record<string, z.infer<typeof PricingIn>> },
): AgentSpec {
  const model = spec.model.model ?? opts.default_model ?? null;
  const fallback = spec.model.fallback_model ?? opts.default_fallback ?? null;
  const price = (ref: string | null) => (ref && opts.pricing?.[ref]) || null;
  return {
    ...spec,
    model: {
      ...spec.model,
      model,
      fallback_model: fallback,
      pricing: price(model) ?? spec.model.pricing,
      fallback_pricing: price(fallback) ?? spec.model.fallback_pricing,
    },
  };
}

const Bind = z.object({
  inbox_id: z.string().trim().min(1).max(64),
  created_by: z.string().max(200).optional(),
});

function validation(draft: unknown) {
  const r = parseSpec(draft);
  return r.ok ? { valid: true, errors: [] } : { valid: false, errors: r.errors };
}

export async function agentRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- agentes
  app.get("/v1/agents", async (req) => {
    const q = req.query as { company_id?: string; mavi_client_id?: string };
    const scope = req.client?.company_scope ?? null;
    const rows = await db()<(AgentRow & { bindings: number })[]>`
      select a.id, a.company_id, a.name, a.origin, a.external_ref, a.status, a.published_version,
             a.draft_updated_at, a.draft_updated_by, a.insights_sample_percent, a.created_at, a.updated_at,
             (select count(*)::int from public.bindings b where b.agent_id = a.id and b.removed_at is null) as bindings
      from public.agents a
      where a.archived_at is null
        and (${q.company_id ?? null}::text is null or a.company_id = ${q.company_id ?? null})
        and (${q.mavi_client_id ?? null}::text is null or a.external_ref->>'mavi_client_id' = ${q.mavi_client_id ?? null})
        and (${scope}::text[] is null or a.company_id = any(${scope}::text[]))
      order by a.name`;
    return { agents: rows };
  });

  app.post("/v1/agents", async (req, reply) => {
    const body = parseBody(CreateAgent, req.body);
    if (!canCompany(req, body.company_id)) throw new HttpError(403, "Sem acesso a esta empresa.");
    const [a] = await db()<AgentRow[]>`
      insert into public.agents (company_id, name, origin, external_ref, draft, draft_updated_by)
      values (${body.company_id}, ${body.name}, ${body.origin}, ${db().json(body.external_ref as never)},
              ${db().json(body.draft as never)}, ${body.created_by ?? req.client!.name})
      returning *`;
    return reply.code(201).send({ agent: a, draft_validation: validation(a!.draft) });
  });

  app.get("/v1/agents/:id", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const [published] = a.published_version
      ? await db()<{ version: number; spec: unknown; note: string; published_by: string | null; created_at: Date }[]>`
          select version, spec, note, published_by, created_at from public.agent_versions
          where agent_id = ${a.id} and version = ${a.published_version}`
      : [];
    const bindings = await db()`
      select id, inbox_id, inbox_name, enabled, created_by, created_at from public.bindings
      where agent_id = ${a.id} and removed_at is null order by created_at`;
    return { agent: a, draft_validation: validation(a.draft), published: published ?? null, bindings };
  });

  app.patch("/v1/agents/:id", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(UpdateAgent, req.body);
    const [row] = await db()<AgentRow[]>`
      update public.agents set
        name = coalesce(${body.name ?? null}, name),
        status = coalesce(${body.status ?? null}, status),
        external_ref = coalesce(${body.external_ref ? db().json(body.external_ref as never) : null}::jsonb, external_ref),
        insights_sample_percent = coalesce(${body.insights_sample_percent ?? null}::int, insights_sample_percent),
        updated_at = now()
      where id = ${a.id} returning *`;
    return { agent: row };
  });

  app.put("/v1/agents/:id/draft", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(Draft, req.body);
    const [row] = await db()<AgentRow[]>`
      update public.agents set draft = ${db().json(body.draft as never)}, draft_updated_at = now(),
        draft_updated_by = ${body.updated_by ?? req.client!.name}, updated_at = now()
      where id = ${a.id} returning *`;
    return { agent: row, draft_validation: validation(row!.draft) };
  });

  app.post("/v1/agents/:id/publish", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(Publish, req.body);
    let spec: unknown;
    if (body.restore_version) {
      const [v] = await db()<{ spec: unknown }[]>`
        select spec from public.agent_versions where agent_id = ${a.id} and version = ${body.restore_version}`;
      if (!v) throw notFound("Versão");
      spec = v.spec;
    } else {
      const r = parseSpec(a.draft);
      if (!r.ok) throw new HttpError(422, "O rascunho tem campos inválidos.", r.errors);
      spec = withModelDefaults(r.spec, body);
    }
    const version = await db().begin(async (tx) => {
      const [{ next } = { next: 1 }] = await tx<{ next: number }[]>`
        select coalesce(max(version), 0) + 1 as next from public.agent_versions where agent_id = ${a.id}`;
      await tx`
        insert into public.agent_versions (agent_id, version, spec, note, restored_from, published_by)
        values (${a.id}, ${next}, ${tx.json(spec as never)}, ${body.note}, ${body.restore_version ?? null},
                ${body.published_by ?? req.client!.name})`;
      await tx`update public.agents set published_version = ${next}, updated_at = now() where id = ${a.id}`;
      return next;
    });
    return { version };
  });

  app.get("/v1/agents/:id/versions", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const versions = await db()`
      select version, note, restored_from, published_by, created_at, spec from public.agent_versions
      where agent_id = ${a.id} order by version desc limit 100`;
    return { versions, published_version: a.published_version };
  });

  app.delete("/v1/agents/:id", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const bindings = await db()<{ id: string }[]>`select id from public.bindings where agent_id = ${a.id} and removed_at is null`;
    for (const b of bindings) await unbind(b.id);
    await db()`update public.agents set archived_at = now(), status = 'paused', updated_at = now() where id = ${a.id}`;
    return { ok: true };
  });

  // ---------------------------------------------------------------- caixas do MakeCRM
  app.get("/v1/makecrm/companies", async (req) => {
    const makeId = Number((req.query as { make_id?: string }).make_id);
    if (!Number.isInteger(makeId) || makeId <= 0) throw new HttpError(400, "Informe make_id (código do cliente).");
    const company = await companyByMakeId(makeId);
    if (!company || !canCompany(req, company.id)) throw notFound("Empresa no MakeCRM");
    return { company };
  });

  app.get("/v1/makecrm/companies/:companyId/inboxes", async (req) => {
    const { companyId } = req.params as { companyId: string };
    if (!canCompany(req, companyId)) throw new HttpError(403, "Sem acesso a esta empresa.");
    const inboxes = await listInboxes(companyId);
    const bound = await db()<{ inbox_id: string; agent_id: string; name: string }[]>`
      select b.inbox_id, b.agent_id, a.name from public.bindings b join public.agents a on a.id = b.agent_id
      where b.company_id = ${companyId} and b.removed_at is null`;
    const byInbox = new Map(bound.map((b) => [b.inbox_id, b]));
    return {
      inboxes: inboxes.map((i) => ({
        ...i,
        kind: i.type_id === 1 ? "whatsapp_uazapi" : "whatsapp_business_api",
        bound_agent: byInbox.get(i.id) ? { id: byInbox.get(i.id)!.agent_id, name: byInbox.get(i.id)!.name } : null,
      })),
    };
  });

  /** Funis e etapas ativos da empresa (para as regras de mover oportunidade). */
  app.get("/v1/makecrm/companies/:companyId/pipelines", async (req) => {
    const { companyId } = req.params as { companyId: string };
    if (!canCompany(req, companyId)) throw new HttpError(403, "Sem acesso a esta empresa.");
    const pipelines = await rest<{ id: string; name: string }[]>(
      `pipelines?select=id,name&company_id=eq.${encodeURIComponent(companyId)}&status=eq.true&order=created_at.asc`,
    );
    const stages = pipelines.length
      ? await rest<{ id: string; name: string; pipeline_id: string; order: number }[]>(
          `pipeline_stages?select=id,name,pipeline_id,order&pipeline_id=in.(${pipelines.map((p) => p.id).join(",")})&status=eq.true&order=order.asc`,
        )
      : [];
    return { pipelines: pipelines.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) })) };
  });

  /** Modelos aprovados do WhatsApp Business API da empresa (para o follow-up fora da janela de 24h). */
  app.get("/v1/makecrm/companies/:companyId/templates", async (req) => {
    const { companyId } = req.params as { companyId: string };
    if (!canCompany(req, companyId)) throw new HttpError(403, "Sem acesso a esta empresa.");
    const list = await listTemplates(companyId);
    return {
      templates: list.map((t) => {
        const b = templateBody(t.content);
        return {
          template_id: t.template_id,
          name: t.name || b.name,
          category: t.category,
          language: b.language,
          text: b.text,
          params: (b.text.match(/\{\{[^}]+\}\}/g) ?? []).length,
          examples: b.examples,
        };
      }),
    };
  });

  /** Usuários ativos da empresa (sem os de IA) e se têm o Google Agenda conectado no MakeCRM. */
  app.get("/v1/makecrm/companies/:companyId/users", async (req) => {
    const { companyId } = req.params as { companyId: string };
    if (!canCompany(req, companyId)) throw new HttpError(403, "Sem acesso a esta empresa.");
    const [users, google] = await Promise.all([
      rest<{ id: string; name: string | null; email: string | null; role: number; is_ia: boolean | null }[]>(
        `users?select=id,name,email,role,is_ia&company_id=eq.${encodeURIComponent(companyId)}&status=eq.true&order=name.asc`,
      ),
      connectedUsers(companyId),
    ]);
    return {
      users: users
        .filter((u) => !u.is_ia && u.role !== 4)
        .map((u) => ({ id: u.id, name: u.name ?? u.email ?? "Usuário", email: u.email, google: google.find((g) => g.user_id === u.id)?.email ?? null })),
    };
  });

  app.post("/v1/agents/:id/bindings", async (req, reply) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(Bind, req.body);
    const inbox = await getInbox(body.inbox_id);
    if (!inbox || inbox.company_id !== a.company_id) throw new HttpError(400, "Caixa não encontrada nesta empresa do MakeCRM.");
    if (inbox.type_id !== 1 && inbox.type_id !== 2) throw new HttpError(400, "Por enquanto só caixas de WhatsApp.");
    const [taken] = await db()<{ agent_id: string }[]>`
      select agent_id from public.bindings where inbox_id = ${inbox.id} and removed_at is null`;
    if (taken) throw new HttpError(409, taken.agent_id === a.id ? "Esta caixa já está ligada a este agente." : "Esta caixa já está ligada a outro agente.");

    const token = newToken("in_");
    const previous = await getInboxWebhook(inbox.id);
    const [binding] = await db()`
      insert into public.bindings (agent_id, company_id, inbox_id, inbox_name, token_hash, previous_webhook_url, created_by)
      values (${a.id}, ${a.company_id}, ${inbox.id}, ${inbox.name}, ${sha256(token)}, ${previous}, ${body.created_by ?? req.client!.name})
      returning id, inbox_id, inbox_name, enabled, created_at`;
    try {
      await setInboxWebhook(inbox.id, inboundUrl(token));
    } catch (e) {
      await db()`delete from public.bindings where id = ${binding!.id}`;
      throw e;
    }
    const warnings: string[] = ["O MakeCRM guarda o endereço da IA por até 1 hora: a troca pode demorar para valer."];
    if (await inboxBlockedByLegacyAgent(inbox.id).catch(() => false)) {
      warnings.push("Esta caixa está ligada a um agente antigo desligado no MakeCRM; o MakeCRM não vai mandar mensagens até desfazer essa conexão lá.");
    }
    return reply.code(201).send({ binding, previous_webhook_url: previous, warnings });
  });

  app.patch("/v1/bindings/:id", async (req) => {
    const { id } = req.params as { id: string };
    assertUuid(id, "Ligação");
    const body = parseBody(z.object({ enabled: z.boolean() }), req.body);
    const [b] = await db()<{ id: string; company_id: string }[]>`
      select id, company_id from public.bindings where id = ${id} and removed_at is null`;
    if (!b || !canCompany(req, b.company_id)) throw notFound("Ligação");
    await db()`update public.bindings set enabled = ${body.enabled} where id = ${id}`;
    return { ok: true };
  });

  app.delete("/v1/bindings/:id", async (req) => {
    const { id } = req.params as { id: string };
    assertUuid(id, "Ligação");
    const [b] = await db()<{ id: string; company_id: string }[]>`
      select id, company_id from public.bindings where id = ${id} and removed_at is null`;
    if (!b || !canCompany(req, b.company_id)) throw notFound("Ligação");
    const restored = await unbind(id);
    return { ok: true, restored_webhook_url: restored };
  });
}

/** Desfaz a ligação: a caixa volta para o endereço que tinha antes (ou fica sem IA). */
async function unbind(bindingId: string): Promise<string | null> {
  const [b] = await db()<{ inbox_id: string; previous_webhook_url: string | null }[]>`
    update public.bindings set removed_at = now(), enabled = false where id = ${bindingId} and removed_at is null
    returning inbox_id, previous_webhook_url`;
  if (!b) return null;
  // Não devolve para outro endereço deste motor (ligação antiga já desfeita).
  const back = b.previous_webhook_url && !b.previous_webhook_url.includes("/v1/inbound/makecrm/") ? b.previous_webhook_url : null;
  await setInboxWebhook(b.inbox_id, back);
  return back;
}
