import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { scheduleTestRun } from "../../queue.js";
import { parseSpec, type AgentSpec } from "../../spec/agent.js";
import { PROFILES, stopRun } from "../../tests/runner.js";
import { assertUuid, HttpError, notFound, parseBody } from "../http.js";
import { loadAgent, ModelDefaults, withModelDefaults } from "./agents.js";

/**
 * Testes com leads simulados: começar uma bateria (rascunho, publicada ou uma
 * versão; "antes de publicar" roda o mesmo par de perfis no rascunho e na
 * publicada), acompanhar, parar e ver cada conversa. Os tetos vêm de quem
 * chama (o MAVI Tasks confere o Painel da MAVI); o motor respeita o da bateria.
 */

const TZ = "America/Sao_Paulo";

/** Reencenar: uma conversa real (as mensagens do lead em cada vez e o que o agente de antes respondeu). */
const Script = z.object({
  nome: z.string().trim().min(1).max(80),
  fonte: z.string().max(200).default(""),
  turns: z
    .array(z.object({ lead: z.array(z.string().max(4000)).min(1).max(20), original: z.array(z.string().max(4000)).max(20).default([]) }))
    .min(1)
    .max(20),
});

/** Um modelo escolhido no treino ("<provedor>:<modelo>") e o preço dele. */
const RunModel = z
  .object({
    ref: z.string().trim().min(1).max(160),
    pricing: z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000), cached: z.number().min(0).max(1000).nullable().optional() }).nullable().default(null),
  })
  .nullable()
  .default(null);
/** Uma conversa do treino: um lead simulado (perfil) ou uma conversa real reencenada (script). */
const TrainingPersona = z
  .object({
    nome: z.string().trim().min(1).max(80),
    perfil: z.string().max(40).default("treino"),
    descricao: z.string().max(1000).default(""),
    objetivo: z.string().max(600).default(""),
    conhece: z.string().max(600).default(""),
    objecoes: z.array(z.string().max(300)).max(10).default([]),
    estilo: z.string().max(300).default(""),
    fim_quando: z.string().max(300).default(""),
    fonte: z.string().max(200).optional(),
    script: z
      .array(z.object({ lead: z.array(z.string().max(4000)).min(1).max(20), original: z.array(z.string().max(4000)).max(20).default([]) }))
      .max(20)
      .optional(),
  })
  .strict();

const Start = z.object({
  kind: z.enum(["manual", "publish", "scheduled", "replay", "training"]).default("manual"),
  /** kind "training": a cópia do rascunho que esta rodada testa, as conversas (as mesmas a cada rodada) e os modelos. */
  spec: z.unknown().optional(),
  personas: z.array(TrainingPersona).max(50).default([]),
  training_id: z.string().trim().min(1).max(64).optional(),
  /** Os modelos da bateria: o agente testado (só no teste), o lead simulado e o avaliador. Ficam em test_runs.models. */
  models: z.object({ agent: RunModel, lead: RunModel, judge: RunModel }).partial().optional(),
  /** kind "replay": as conversas reais, uma por conversa da bateria. */
  scripts: z.array(Script).max(30).default([]),
  use: z.union([z.literal("draft"), z.literal("published"), z.number().int().min(1)]).default("draft"),
  conversations: z.number().int().min(1).max(50),
  max_turns: z.number().int().min(2).max(20).default(8),
  cost_cap_usd: z.number().positive().max(100),
  profiles: z.array(z.string().max(40)).max(20).default([]),
  focus: z.string().max(1000).default(""),
  created_by: z.string().max(200).optional(),
  /** O padrão do Painel da MAVI para o rascunho (a versão publicada já vem com o dela). */
  ...ModelDefaults,
});

export async function testRoutes(app: FastifyInstance) {
  app.get("/v1/test-profiles", async () => ({ profiles: Object.entries(PROFILES).map(([key, v]) => ({ key, ...v })) }));

  app.post("/v1/agents/:id/test-runs", async (req, reply) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const body = parseBody(Start, req.body);
    const profiles = body.profiles.filter((p) => PROFILES[p]);
    const sql = db();
    // Outro modelo para o agente testado (Leads simulados); o antes de publicar compara sempre com o modelo do próprio agente.
    const agentModel = (spec: AgentSpec): AgentSpec =>
      body.kind === "publish" || !body.models?.agent
        ? spec
        : { ...spec, model: { ...spec.model, model: body.models.agent.ref, pricing: body.models.agent.pricing ?? spec.model.pricing } };
    const specOf = async (use: "draft" | "published" | number) => {
      if (body.spec !== undefined) {
        const r = parseSpec(body.spec);
        if (!r.ok) throw new HttpError(422, "A cópia do rascunho tem campos inválidos.", r.errors);
        return { spec: withModelDefaults(r.spec, body), version: null as number | null };
      }
      if (use === "draft") {
        const r = parseSpec(a.draft);
        if (!r.ok) throw new HttpError(422, "O rascunho tem campos inválidos: corrija antes de testar.", r.errors);
        return { spec: agentModel(withModelDefaults(r.spec, body)), version: null as number | null };
      }
      const version = use === "published" ? a.published_version : use;
      if (!version) throw new HttpError(400, "O agente ainda não tem versão publicada.");
      const [v] = await sql<{ spec: unknown }[]>`select spec from public.agent_versions where agent_id = ${a.id} and version = ${version}`;
      const r = parseSpec(v?.spec);
      if (!r.ok) throw notFound("Versão");
      return { spec: agentModel(r.spec), version };
    };
    if (body.kind === "replay" && !body.scripts.length) throw new HttpError(400, "Mande as conversas para reencenar.");
    // As conversas prontas (reais, casos) podem faltar: o que faltar para "conversations" vira lead simulado.
    if (body.kind === "training" && (!body.training_id || body.spec === undefined))
      throw new HttpError(400, "O treino manda a cópia do rascunho e o id do treino.");
    // Leads simulados também mandam leads prontos (conversa real reencenada ou lead parecido com um real);
    // o que faltar para "conversations" vira lead simulado.
    const personas: unknown[] =
      body.kind === "training" || body.kind === "manual"
        ? body.personas
        : body.kind === "replay"
        ? body.scripts.map((x) => ({
            nome: x.nome,
            perfil: "replay",
            descricao: "Conversa real reencenada",
            objetivo: "",
            conhece: "",
            objecoes: [],
            estilo: "",
            fim_quando: "",
            fonte: x.fonte,
            script: x.turns,
          }))
        : [];
    const insert = async (use: "draft" | "published" | number, compareTo: string | null) => {
      const s = await specOf(use);
      const conversations = body.kind === "training" || body.kind === "manual" ? Math.max(personas.length, body.conversations) : personas.length || body.conversations;
      const scripted = personas.map((x) => ((x as { script?: unknown[] }).script ?? []).length);
      const maxTurns = body.kind === "replay" ? Math.min(20, Math.max(2, ...scripted)) : body.kind === "training" || body.kind === "manual" ? Math.min(20, Math.max(body.max_turns, ...scripted)) : body.max_turns;
      const [row] = await sql<{ id: string }[]>`
        insert into public.test_runs (agent_id, kind, agent_version, spec, compare_to, profiles, focus, personas, conversations, max_turns, cost_cap_usd, created_by,
                                      training_id, models)
        values (${a.id}, ${body.kind}, ${s.version}, ${sql.json(s.spec as never)}, ${compareTo}, ${profiles}, ${body.focus}, ${sql.json(personas as never)},
                ${conversations}, ${maxTurns}, ${body.cost_cap_usd}, ${body.created_by ?? req.client!.name},
                ${body.training_id ?? null}, ${body.models ? sql.json(body.models as never) : null})
        returning id`;
      return row!.id;
    };
    // Antes de publicar: o rascunho e a versão publicada com os mesmos perfis (o teto vale para cada uma).
    if (body.kind === "publish" && a.published_version) {
      const draft = await insert("draft", null);
      const published = await insert("published", draft);
      await sql`update public.test_runs set compare_to = ${published} where id = ${draft}`;
      await scheduleTestRun(draft);
      return reply.code(201).send({ runs: [draft, published] });
    }
    const id = await insert(body.use, null);
    await scheduleTestRun(id);
    return reply.code(201).send({ runs: [id] });
  });

  app.get("/v1/agents/:id/test-runs", async (req) => {
    const a = await loadAgent(req, (req.params as { id: string }).id);
    const q = req.query as { limit?: string };
    const runs = await db()`
      select r.id, r.kind, r.agent_version, r.compare_to, r.profiles, r.focus, r.conversations, r.max_turns, r.cost_cap_usd::float8 as cost_cap_usd, r.models,
             r.spec -> 'model' ->> 'model' as agent_model,
             r.cost_usd::float8 as cost_usd, r.status, r.stop_reason, r.summary, r.error, r.created_by, r.created_at, r.started_at, r.finished_at,
             (select count(*) from public.test_conversations c where c.run_id = r.id and c.status not in ('queued', 'running'))::int as finished
      from public.test_runs r where r.agent_id = ${a.id} and r.training_id is null
      order by r.created_at desc limit ${Math.min(Number(q.limit) || 20, 100)}`;
    // O que os testes gastaram no mês (para o teto mensal de quem chama).
    const [month] = await db()<{ c: number }[]>`
      select coalesce(sum(e.cost_usd), 0)::float8 as c from public.cost_events e
      where e.agent_id = ${a.id} and e.simulation
        and e.created_at >= date_trunc('month', now() at time zone ${TZ}) at time zone ${TZ}
        and (e.source like 'test\\_%' or e.conversation_id in (
          select c.id from public.conversations c where c.agent_id = ${a.id} and c.simulation and c.external_id like 'test:%'))`;
    return { runs, month_cost_usd: month?.c ?? 0 };
  });

  app.get("/v1/agents/:id/test-runs/:rid", async (req) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const a = await loadAgent(req, id);
    assertUuid(rid, "Bateria");
    const [run] = await db()`
      select id, kind, agent_version, compare_to, profiles, focus, personas, conversations, max_turns, cost_cap_usd::float8 as cost_cap_usd, models,
             spec -> 'model' ->> 'model' as agent_model,
             cost_usd::float8 as cost_usd, status, stop_reason, summary, error, created_by, created_at, started_at, finished_at
      from public.test_runs where id = ${rid} and agent_id = ${a.id}`;
    if (!run) throw notFound("Bateria");
    const conversations = await db()`
      select id, idx, persona, conversation_id, status, turns, verdict, cost_usd::float8 as cost_usd, error, finished_at
      from public.test_conversations where run_id = ${rid} order by idx`;
    return { run, conversations };
  });

  app.post("/v1/agents/:id/test-runs/:rid/stop", async (req) => {
    const { id, rid } = req.params as { id: string; rid: string };
    const a = await loadAgent(req, id);
    assertUuid(rid, "Bateria");
    const [run] = await db()<{ id: string; compare_to: string | null }[]>`select id, compare_to from public.test_runs where id = ${rid} and agent_id = ${a.id}`;
    if (!run) throw notFound("Bateria");
    await stopRun(run.id, "parada por quem testa");
    if (run.compare_to) await stopRun(run.compare_to, "parada por quem testa");
    return { ok: true };
  });

  /** Baterias terminadas desde um momento (o aviso das periódicas, no MAVI Tasks). */
  app.post("/v1/test-runs/finished", async (req) => {
    const body = parseBody(z.object({ since: z.string().datetime(), kind: z.enum(["manual", "publish", "scheduled", "replay"]).optional() }), req.body);
    const runs = await db()`
      select r.id, r.agent_id, r.kind, r.status, r.summary, r.cost_usd::float8 as cost_usd, r.finished_at, a.name as agent_name, a.external_ref
      from public.test_runs r join public.agents a on a.id = r.agent_id
      where r.finished_at >= ${body.since}::timestamptz and (${body.kind ?? null}::text is null or r.kind = ${body.kind ?? null})
        and (${req.client?.company_scope ?? null}::text[] is null or a.company_id = any(${req.client?.company_scope ?? null}::text[]))
      order by r.finished_at`;
    return { runs };
  });
}
