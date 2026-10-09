import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ingestItem } from "./knowledge/ingest.js";
import { log } from "./log.js";
import {
  QUEUE,
  scheduleFollowup,
  scheduleReminder,
  scheduleTestConversation,
  scheduleTurn,
  type FollowupJob,
  type KnowledgeJob,
  type ReminderJob,
  type TestJob,
  type TurnJob,
} from "./queue.js";
import { confirmationAlert, processReminder, stepState, type MeetingRow } from "./runtime/reminders.js";
import { runConversation, startRun } from "./tests/runner.js";
import { db } from "./db.js";
import { processFollowup } from "./runtime/followup.js";
import { analyzeDue } from "./insights/analyze.js";
import { clusterGaps } from "./insights/gaps.js";
import { redis, redisConnection } from "./redis.js";
import { lastMessageKey } from "./api/routes/inbound.js";
import { publishedSpec, runTurn } from "./runtime/turn.js";

/** Trava por conversa: uma resposta por vez. */
const LOCK_MS = 5 * 60_000;
const lockKey = (id: string) => `conv:lock:${id}`;
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function processTurn(job: TurnJob): Promise<string> {
  const { conversationId, messageId, attempt = 0 } = job;
  const last = await redis().get(lastMessageKey(conversationId));
  if (last && last !== messageId) return "superada"; // chegou mensagem mais nova: aquela responde por todas
  const token = randomUUID();
  const locked = await redis().set(lockKey(conversationId), token, "PX", LOCK_MS, "NX");
  if (!locked) {
    if (attempt < 120) await scheduleTurn(conversationId, messageId, 2000, attempt + 1);
    return "aguardando a resposta anterior";
  }
  try {
    const r = await runTurn({ conversationId });
    return r.status;
  } finally {
    await redis().eval(RELEASE, 1, lockKey(conversationId), token);
  }
}

/** Uma etapa de follow-up, com a mesma trava da conversa que as respostas. */
export async function processFollowupJob(job: FollowupJob): Promise<string> {
  const { conversationId, step, attempt = 0 } = job;
  const token = randomUUID();
  const locked = await redis().set(lockKey(conversationId), token, "PX", LOCK_MS, "NX");
  if (!locked) {
    if (attempt < 60) await scheduleFollowup(conversationId, step, 5000, attempt + 1);
    return "aguardando a resposta em andamento";
  }
  try {
    return await processFollowup(conversationId, step);
  } finally {
    await redis().eval(RELEASE, 1, lockKey(conversationId), token);
  }
}

/** Uma etapa da régua de pré-reunião, com a mesma trava da conversa que as respostas. */
export async function processReminderJob(job: ReminderJob): Promise<string> {
  const token = randomUUID();
  const locked = await redis().set(lockKey(job.conversationId), token, "PX", LOCK_MS, "NX");
  if (!locked) {
    if ((job.attempt ?? 0) < 60) await scheduleReminder({ ...job, attempt: (job.attempt ?? 0) + 1 }, 5000);
    return "aguardando a resposta em andamento";
  }
  try {
    return await processReminder(job.meetingId, job.stepId, job.startsAt);
  } finally {
    await redis().eval(RELEASE, 1, lockKey(job.conversationId), token);
  }
}

/**
 * A cada minuto (com trava): as etapas vencidas da régua de pré-reunião das
 * reuniões marcadas pelo agente entram na fila, e quem não confirmou presença
 * até o limite vira aviso à equipe.
 */
async function remindersTick() {
  const ok = await redis().set("rem:tick", "1", "PX", 55_000, "NX");
  if (!ok) return;
  const sql = db();
  const meetings = await sql<MeetingRow[]>`
    select m.* from public.agent_meetings m
    join public.conversations c on c.id = m.conversation_id and not c.simulation
    join public.bindings b on b.id = c.binding_id and b.enabled and b.removed_at is null
    join public.agents a on a.id = m.agent_id and a.status = 'active' and a.archived_at is null
    where m.status = 'scheduled' and m.starts_at < now() + interval '15 days' and m.ends_at > now() - interval '15 days'
    order by m.starts_at limit 2000`;
  if (!meetings.length) return;
  const done = new Set(
    (
      await sql<{ meeting_id: string; step_id: string; starts_at: Date }[]>`
        select meeting_id, step_id, starts_at from public.meeting_reminder_log where meeting_id = any (${meetings.map((m) => m.id)}::uuid[])`
    ).map((r) => `${r.meeting_id}:${r.step_id}:${r.starts_at.getTime()}`),
  );
  for (const m of meetings) {
    const cfg = (await publishedSpec(m.agent_id).catch(() => null))?.spec.meeting_reminders;
    if (!cfg?.enabled) continue;
    for (const step of cfg.steps) {
      if (done.has(`${m.id}:${step.id}:${m.starts_at.getTime()}`)) continue;
      // Pular também passa pelo job: fica registrado (com o motivo) no log da régua.
      if (stepState(step, m, cfg.window).action === "wait") continue;
      await scheduleReminder({ conversationId: m.conversation_id, meetingId: m.id, stepId: step.id, startsAt: m.starts_at.toISOString() });
    }
    if (m.confirmation === "asked" && !m.confirmation_alerted) await confirmationAlert(m).catch((e) => log.warn({ err: String(e) }, "pré-reunião: alerta de confirmação falhou"));
  }
}

/** A cada minuto, um worker (com trava) põe na fila as etapas de follow-up vencidas. */
async function followupTick() {
  const ok = await redis().set("fu:tick", "1", "PX", 55_000, "NX");
  if (!ok) return;
  const due = await db()<{ id: string; followup_step: number; followup_next_at: Date }[]>`
    select c.id, c.followup_step, c.followup_next_at from public.conversations c
    join public.bindings b on b.id = c.binding_id and b.enabled and b.removed_at is null
    join public.agents a on a.id = c.agent_id and a.status = 'active' and a.archived_at is null
    where c.followup_state = 'active' and c.followup_next_at <= now() and not c.simulation
    order by c.followup_next_at limit 500`;
  for (const c of due) await scheduleFollowup(c.id, c.followup_step, 0, 0, String(c.followup_next_at.getTime()));
}

/**
 * A cada 2 minutos, um worker (com trava): as lacunas novas entram nos temas e
 * as conversas que esfriaram (na amostra de cada agente) são lidas.
 */
async function insightsTick() {
  const ok = await redis().set("ins:tick", "1", "PX", 10 * 60_000, "NX");
  if (!ok) return;
  try {
    const gaps = await clusterGaps().catch((e) => (log.error({ err: String(e) }, "lacunas: agrupamento falhou"), 0));
    const read = await analyzeDue();
    if (gaps || read) log.info({ gaps, read }, "insights: rodada");
  } finally {
    await redis().del("ins:tick");
  }
}

export function startWorkers() {
  // Gastos feitos pela imagem anterior (antes do registro separado de custos) entram no relatório.
  void db()`select public.cost_backfill() as n`
    .then(([r]) => r?.n && log.info({ n: r.n }, "custos: gastos antigos registrados"))
    .catch((e) => log.warn({ err: String(e) }, "custos: backfill falhou"));
  const turns = new Worker<TurnJob | FollowupJob | ReminderJob>(
    QUEUE.turns,
    async (job) =>
      job.name === "followup"
        ? processFollowupJob(job.data as FollowupJob)
        : job.name === "reminder"
          ? processReminderJob(job.data as ReminderJob)
          : processTurn(job.data as TurnJob),
    {
    connection: redisConnection(true),
    concurrency: config().WORKER_CONCURRENCY,
  });
  const knowledge = new Worker<KnowledgeJob>(QUEUE.knowledge, async (job) => ingestItem(job.data.itemId), {
    connection: redisConnection(true),
    concurrency: 4,
  });
  // Testes com leads simulados: poucas conversas ao mesmo tempo (não disputam com as reais).
  const tests = new Worker<TestJob>(
    QUEUE.tests,
    async (job) => (job.name === "test-run" ? (await startRun(job.data.runId, scheduleTestConversation), "começou") : runConversation(job.data.runId, job.data.idx ?? 0)),
    { connection: redisConnection(true), concurrency: 3 },
  );
  for (const w of [turns, knowledge, tests]) {
    w.on("failed", (job, err) => log.error({ queue: w.name, job: job?.id, err: err.message }, "worker: job falhou"));
    w.on("error", (err) => log.error({ queue: w.name, err: err.message }, "worker: erro"));
  }
  const tick = setInterval(() => {
    void followupTick().catch((e) => log.error({ err: String(e) }, "follow-up: varredura falhou"));
    void remindersTick().catch((e) => log.error({ err: String(e) }, "pré-reunião: varredura falhou"));
  }, 60_000);
  const insights = setInterval(() => void insightsTick().catch((e) => log.error({ err: String(e) }, "insights: rodada falhou")), 2 * 60_000);
  turns.on("closing", () => {
    clearInterval(tick);
    clearInterval(insights);
  });
  return [turns, knowledge, tests];
}
