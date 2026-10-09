import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";

export const QUEUE = { turns: "turns", knowledge: "knowledge" } as const;

export type TurnJob = { conversationId: string; messageId: string; attempt?: number };
export type KnowledgeJob = { itemId: string };

let turns: Queue<TurnJob> | null = null;
let knowledge: Queue<KnowledgeJob> | null = null;

export function turnsQueue() {
  turns ??= new Queue<TurnJob>(QUEUE.turns, { connection: redisConnection() });
  return turns;
}
export function knowledgeQueue() {
  knowledge ??= new Queue<KnowledgeJob>(QUEUE.knowledge, { connection: redisConnection() });
  return knowledge;
}

/** Agenda a resposta para depois da espera; só a mensagem mais recente da conversa roda. */
export async function scheduleTurn(conversationId: string, messageId: string, delayMs: number, attempt = 0) {
  await turnsQueue().add(
    "turn",
    { conversationId, messageId, attempt },
    {
      delay: delayMs,
      jobId: `t-${conversationId}-${messageId}-${attempt}`,
      removeOnComplete: { count: 2000 },
      removeOnFail: { count: 5000 },
    },
  );
}

export async function scheduleIngest(itemId: string) {
  await knowledgeQueue().add(
    "ingest",
    { itemId },
    {
      jobId: `k-${itemId}-${Date.now()}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 2000 },
    },
  );
}

export async function closeQueues() {
  await Promise.all([turns?.close(), knowledge?.close()]);
  turns = knowledge = null;
}
