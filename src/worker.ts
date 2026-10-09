import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ingestItem } from "./knowledge/ingest.js";
import { log } from "./log.js";
import { QUEUE, scheduleFollowup, scheduleTurn, type FollowupJob, type KnowledgeJob, type TurnJob } from "./queue.js";
import { db } from "./db.js";
import { processFollowup } from "./runtime/followup.js";
import { redis, redisConnection } from "./redis.js";
import { lastMessageKey } from "./api/routes/inbound.js";
import { runTurn } from "./runtime/turn.js";

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

export function startWorkers() {
  const turns = new Worker<TurnJob | FollowupJob>(
    QUEUE.turns,
    async (job) => (job.name === "followup" ? processFollowupJob(job.data as FollowupJob) : processTurn(job.data as TurnJob)),
    {
    connection: redisConnection(true),
    concurrency: config().WORKER_CONCURRENCY,
  });
  const knowledge = new Worker<KnowledgeJob>(QUEUE.knowledge, async (job) => ingestItem(job.data.itemId), {
    connection: redisConnection(true),
    concurrency: 4,
  });
  for (const w of [turns, knowledge]) {
    w.on("failed", (job, err) => log.error({ queue: w.name, job: job?.id, err: err.message }, "worker: job falhou"));
    w.on("error", (err) => log.error({ queue: w.name, err: err.message }, "worker: erro"));
  }
  const tick = setInterval(() => void followupTick().catch((e) => log.error({ err: String(e) }, "follow-up: varredura falhou")), 60_000);
  turns.on("closing", () => clearInterval(tick));
  return [turns, knowledge];
}
