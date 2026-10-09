import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";

export const QUEUE = { turns: "turns", knowledge: "knowledge", tests: "tests" } as const;

export type TurnJob = { conversationId: string; messageId: string; attempt?: number };
export type FollowupJob = { conversationId: string; step: number; attempt?: number };
export type KnowledgeJob = { itemId: string };
/** Testes com leads simulados: começar a bateria ou uma conversa dela. */
export type TestJob = { runId: string; idx?: number };

let turns: Queue<TurnJob | FollowupJob> | null = null;
let knowledge: Queue<KnowledgeJob> | null = null;
let tests: Queue<TestJob> | null = null;

export function turnsQueue() {
  turns ??= new Queue<TurnJob | FollowupJob>(QUEUE.turns, { connection: redisConnection() });
  return turns;
}
export function testsQueue() {
  tests ??= new Queue<TestJob>(QUEUE.tests, { connection: redisConnection() });
  return tests;
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

/** Uma etapa da régua de follow-up (na mesma fila das respostas: uma coisa por vez por conversa). */
export async function scheduleFollowup(conversationId: string, step: number, delayMs = 0, attempt = 0, key = "") {
  await turnsQueue().add(
    "followup",
    { conversationId, step, attempt },
    {
      delay: delayMs,
      jobId: `f-${conversationId}-${step}-${key || attempt}`,
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

export async function scheduleTestRun(runId: string) {
  await testsQueue().add("test-run", { runId }, { jobId: `tr-${runId}`, removeOnComplete: { count: 500 }, removeOnFail: { count: 1000 } });
}
export async function scheduleTestConversation(runId: string, idx: number) {
  await testsQueue().add("test-conv", { runId, idx }, { jobId: `tc-${runId}-${idx}`, removeOnComplete: { count: 2000 }, removeOnFail: { count: 2000 } });
}

export async function closeQueues() {
  await Promise.all([turns?.close(), knowledge?.close(), tests?.close()]);
  turns = knowledge = tests = null;
}
