import { z } from "zod";

/**
 * APIs externas do agente: endereços de outros sistemas do cliente (estoque,
 * pedidos, agenda própria, cadastro…) que o agente consulta ou para onde envia
 * dados na conversa. Cada API vira uma ferramenta `api_<id>`. A chave de acesso
 * não fica aqui: vai para o cofre do motor (agent_api_secrets) e vale para
 * todas as versões.
 */

const text = (max: number) => z.string().trim().max(max);

/** Nome de campo (ex.: numero_pedido, cliente.nome para JSON aninhado). */
const fieldName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z_][A-Za-z0-9_\-]*(\.[A-Za-z_][A-Za-z0-9_\-]*)*$/, "Use letras, números, _ ou - (e ponto para campos aninhados).");

/**
 * Um dado da chamada. De onde vem o valor:
 * - agent: o agente preenche pela conversa (com a descrição como guia);
 * - fixed: sempre o mesmo valor;
 * - contact: um dado do contato (phone, name) ou um dado registrado (fact:<campo>).
 */
export const ApiParam = z
  .object({
    name: fieldName,
    in: z.enum(["path", "query", "body", "header"]),
    source: z.enum(["agent", "fixed", "contact"]).default("agent"),
    description: text(300).default(""),
    type: z.enum(["string", "number", "integer", "boolean"]).default("string"),
    required: z.boolean().default(true),
    /** fixed: o valor; contact: phone, name ou fact:<campo>. */
    value: text(2000).default(""),
    /** Só para source=agent: valores aceitos (vira lista no modelo). */
    options: z.array(text(120).min(1)).max(30).default([]),
  })
  .strict()
  .refine((p) => p.source !== "fixed" || p.value !== "", { message: "Informe o valor fixo.", path: ["value"] })
  .refine((p) => p.source !== "contact" || /^(phone|name|fact:[A-Za-z0-9_]{1,60})$/.test(p.value), {
    message: "Escolha o dado do contato.",
    path: ["value"],
  });

export const ApiAuth = z
  .object({
    /** none; bearer (Authorization: Bearer); header (chave num cabeçalho); query (chave na URL); basic (usuário:senha). */
    type: z.enum(["none", "bearer", "header", "query", "basic"]).default("none"),
    /** Nome do cabeçalho ou do parâmetro (header/query). */
    name: text(80).default(""),
  })
  .strict()
  .refine((a) => !(a.type === "header" || a.type === "query") || a.name !== "", { message: "Informe o nome do campo da chave.", path: ["name"] });

export const ExternalApi = z
  .object({
    /** Vira o nome da ferramenta (api_<id>): minúsculas, números e _. */
    id: z.string().trim().min(2).max(40).regex(/^[a-z][a-z0-9_]*$/, "Use minúsculas, números e _ (começando com letra)."),
    enabled: z.boolean().default(true),
    name: text(80).min(1, "Dê um nome à API."),
    /** Quando o agente deve usar (vai para o modelo como a descrição da ferramenta). */
    when: text(1000).min(3, "Diga quando o agente deve usar esta API."),
    /** read: só consulta; write: envia/grava dados (o agente confirma com o lead antes). */
    kind: z.enum(["read", "write"]).default("read"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    /** https://… com {campo} para os dados no caminho. */
    url: z
      .string()
      .trim()
      .min(8)
      .max(1000)
      .regex(/^https?:\/\/[^\s]+$/i, "Endereço precisa começar com https://"),
    params: z.array(ApiParam).max(30).default([]),
    /** Cabeçalhos fixos que não são segredo (ex.: Accept). */
    headers: z.array(z.object({ name: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9\-_]+$/), value: text(500) }).strict()).max(15).default([]),
    auth: ApiAuth.default({ type: "none", name: "" }),
    /** Corpo como JSON ou formulário (application/x-www-form-urlencoded). */
    body_format: z.enum(["json", "form"]).default("json"),
    response: z
      .object({
        /** Caminhos a guardar da resposta (ex.: data.status, itens.0.preco); vazio = tudo. */
        pick: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
        /** Como o agente deve usar a resposta (ex.: "o prazo está em dias úteis"). */
        instructions: text(1000).default(""),
        /** Até quantos caracteres da resposta vão para o agente. */
        max_chars: z.number().int().min(200).max(12_000).default(3000),
      })
      .strict()
      .default({ pick: [], instructions: "", max_chars: 3000 }),
    /** Roda sozinha no começo da conversa e o resultado vira contexto (só com dados fixos ou do contato). */
    on_start: z.boolean().default(false),
    timeout_seconds: z.number().int().min(3).max(30).default(15),
  })
  .strict()
  .superRefine((api, ctx) => {
    const names = new Set<string>();
    api.params.forEach((p, i) => {
      const key = `${p.in}:${p.name}`;
      if (names.has(key)) ctx.addIssue({ code: "custom", message: "Campo repetido.", path: ["params", i, "name"] });
      names.add(key);
    });
    for (const m of api.url.matchAll(/\{([^}]+)\}/g)) {
      if (!api.params.some((p) => p.in === "path" && p.name === m[1]))
        ctx.addIssue({ code: "custom", message: `Falta o campo {${m[1]}} do endereço em Dados da chamada.`, path: ["url"] });
    }
    api.params.forEach((p, i) => {
      if (p.in === "path" && !api.url.includes(`{${p.name}}`))
        ctx.addIssue({ code: "custom", message: `Ponha {${p.name}} no endereço ou mude onde o campo vai.`, path: ["params", i, "in"] });
    });
    if (api.method === "GET" && api.params.some((p) => p.in === "body"))
      ctx.addIssue({ code: "custom", message: "GET não tem corpo: mande os campos na URL (query).", path: ["method"] });
    if (api.on_start && api.params.some((p) => p.source === "agent" && p.required))
      ctx.addIssue({
        code: "custom",
        message: "Para rodar no começo da conversa, todos os dados obrigatórios precisam ser fixos ou do contato.",
        path: ["on_start"],
      });
    if (api.on_start && api.kind === "write")
      ctx.addIssue({ code: "custom", message: "Só APIs de consulta rodam sozinhas no começo da conversa.", path: ["on_start"] });
  });

export const ExternalApis = z
  .array(ExternalApi)
  .max(20)
  .default([])
  .superRefine((list, ctx) => {
    const ids = new Set<string>();
    list.forEach((a, i) => {
      if (ids.has(a.id)) ctx.addIssue({ code: "custom", message: "Já existe outra API com este código.", path: [i, "id"] });
      ids.add(a.id);
    });
  });

export type ExternalApiT = z.infer<typeof ExternalApi>;
export type ApiParamT = z.infer<typeof ApiParam>;
export const API_TOOL_PREFIX = "api_";
export const apiToolName = (id: string) => `${API_TOOL_PREFIX}${id}`;
