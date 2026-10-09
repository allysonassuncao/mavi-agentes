import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { db } from "../db.js";
import { log } from "../log.js";
import { redis } from "../redis.js";
import { authenticate } from "./auth.js";
import { HttpError } from "./http.js";
import { agentRoutes } from "./routes/agents.js";
import { inboundRoutes } from "./routes/inbound.js";
import { insightRoutes } from "./routes/insights.js";
import { costRoutes } from "./routes/costs.js";
import { testRoutes } from "./routes/tests.js";
import { integrationCheckRoutes } from "./routes/integration-checks.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { secretRoutes } from "./routes/secrets.js";
import { simulateRoutes } from "./routes/simulate.js";

export async function buildServer() {
  const app = Fastify({ loggerInstance: log, bodyLimit: 5 * 1024 * 1024, trustProxy: true, disableRequestLogging: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, details: err.details });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    req.log.error({ err, url: req.url }, "api: erro");
    return reply.code(500).send({ error: "Erro interno." });
  });

  app.get("/health", async () => {
    const [dbOk, redisOk] = await Promise.all([
      db()`select 1`.then(() => true, () => false),
      redis().ping().then(() => true, () => false),
    ]);
    return { ok: dbOk && redisOk, db: dbOk, redis: redisOk };
  });

  // Entrada do MakeCRM: autenticada pelo token da URL.
  await app.register(inboundRoutes);

  // Administração: chave da API.
  await app.register(async (admin) => {
    admin.addHook("onRequest", authenticate);
    await admin.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
    await admin.register(agentRoutes);
    await admin.register(knowledgeRoutes);
    await admin.register(simulateRoutes);
    await admin.register(secretRoutes);
    await admin.register(insightRoutes);
    await admin.register(costRoutes);
    await admin.register(testRoutes);
    await admin.register(integrationCheckRoutes);
  });

  return app;
}
