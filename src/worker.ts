import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ingestItem } from "./knowledge/ingest.js";
import { log } from "./log.js";
import { QUEUE, scheduleTurn, type KnowledgeJob, type TurnJob } from "./queue.js";
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

export function startWorkers() {
  const turns = new Worker<TurnJob>(QUEUE.turns, async (job) => processTurn(job.data), {
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
  return [turns, knowledge];
}
