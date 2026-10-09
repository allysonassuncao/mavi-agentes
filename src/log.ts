import { pino } from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Nunca registrar chaves nem o token do provedor que vem do MakeCRM.
  redact: {
    paths: ["*.provider_token", "provider_token", "*.authorization", "*.apikey", "headers.authorization", "req.headers.authorization"],
    censor: "[oculto]",
  },
});
