import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default("info"),
  // Endereço público deste motor (vai na URL que o MakeCRM chama).
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),

  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().default(10),
  REDIS_URL: z.string().default("redis://localhost:6379/0"),

  // Supabase do motor (Storage dos arquivos da base de conhecimento).
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  KNOWLEDGE_BUCKET: z.string().default("knowledge"),

  // LLMs. OpenRouter para conversar; OpenAI para vetores e transcrição.
  OPENROUTER_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  // Opcionais: chaves do motor para outros provedores (os agentes podem ter as suas).
  ANTHROPIC_API_KEY: z.string().default(""),
  GOOGLE_API_KEY: z.string().default(""),
  // Google Agenda: o mesmo aplicativo OAuth do MakeCRM (para renovar o acesso às agendas conectadas lá).
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(""),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(""),
  // As automações do MakeCRM ao mudar a etapa (o mesmo endereço que a tela do MakeCRM chama).
  MAKECRM_AUTOMATIONS_URL: z.string().default("https://api.maso.app.br/webhook/e3a08c6a-19a6-42fc-9ca0-fdf959e0d545"),
  // Envio de modelos aprovados do WhatsApp Business API (o serviço de mensagens do MakeCRM).
  MAKECRM_TEMPLATE_URL: z.string().default("https://makecrm-messages.maso.app.br/send-whatsapp-template"),
  // Cofre das chaves dos agentes: 32 bytes em base64 (openssl rand -base64 32).
  SECRETS_KEY: z.string().default(""),
  DEFAULT_MODEL: z.string().default("openai/gpt-5.2"),
  FALLBACK_MODEL: z.string().default("openai/gpt-4.1"),
  // Tarefas de apoio: resumo, contexto dos trechos, descrição de imagem.
  UTILITY_MODEL: z.string().default("openai/gpt-5-mini"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),

  // MakeCRM (Supabase do MakeCRM): sendMessage, ia_actived e webhook da caixa.
  MAKECRM_SUPABASE_URL: z.string().url(),
  MAKECRM_PUBLISHABLE_KEY: z.string().min(1),
  MAKECRM_SECRET_KEY: z.string().min(1),
  // true: não envia nada ao MakeCRM (só registra) — para testes.
  MAKECRM_DRY_RUN: z
    .string()
    .default("false")
    .transform((v) => ["1", "true", "sim", "yes"].includes(v.trim().toLowerCase())),

  WORKER_CONCURRENCY: z.coerce.number().int().default(20),
});

export type Config = z.infer<typeof Env>;

let cached: Config | null = null;
export function config(): Config {
  if (!cached) {
    const parsed = Env.safeParse(process.env);
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Configuração inválida: ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}
