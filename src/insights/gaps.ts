import { config } from "../config.js";
import { db, toVector } from "../db.js";
import { searchKnowledge } from "../knowledge/search.js";
import { chat, embed } from "../llm/client.js";
import { log } from "../log.js";
import { rest } from "../makecrm/client.js";
import { scheduleIngest } from "../queue.js";
import { publishedSpec } from "../runtime/turn.js";
import { parseSpec, type AgentSpec } from "../spec/agent.js";
import { agentKeys } from "../secrets.js";
import type { GapKind } from "./gap-capture.js";

/**
 * Lacunas do treinamento. Na mesma chamada em que responde, o agente avisa
 * (campo `lacunas` da ferramenta responder) o que o lead perguntou/objetou e
 * o treinamento não cobria. Aqui as ocorrências viram temas (pelo vetor), a
 * MAVI sugere a resposta (material + como a equipe respondeu) e, aplicada,
 * ela entra no conhecimento como pergunta frequente.
 */

/** Mais parecido que isto com um tema existente = mesma lacuna. */
export const GAP_SIMILARITY = 0.8;
/** A partir de quantas ocorrências a MAVI dá um título ao tema. */
const NAME_AT = 3;

// ---------------------------------------------------------------- temas

/** Recalcula contagens, datas e o centro do tema a partir das ocorrências. */
export async function refreshTopic(topicId: string) {
  await db()`
    update public.gap_topics t set
      occurrences = s.n, conversations = s.c,
      first_seen_at = coalesce(s.first, t.first_seen_at), last_seen_at = coalesce(s.last, t.last_seen_at),
      after_trained = case when t.trained_at is null then 0 else s.after end,
      centroid = coalesce(s.centroid, t.centroid), updated_at = now()
    from (
      select count(*)::int as n, count(distinct g.conversation_id)::int as c, min(g.created_at) as first, max(g.created_at) as last,
             count(*) filter (where g.created_at > (select trained_at from public.gap_topics where id = ${topicId}))::int as after,
             avg(g.embedding) as centroid
      from public.gaps g where g.topic_id = ${topicId}
    ) s
    where t.id = ${topicId}`;
}

/** Põe as ocorrências novas no tema mais parecido (ou abre um tema). */
export async function clusterGaps(limit = 300): Promise<number> {
  const sql = db();
  const rows = await sql<{ id: string; agent_id: string; kind: GapKind; text: string; category: string }[]>`
    select id, agent_id, kind, text, category from public.gaps where topic_id is null order by id limit ${limit}`;
  if (!rows.length) return 0;
  const { vectors } = await embed(rows.map((r) => r.text));
  const touched = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const v = toVector(vectors[i]!);
    const [near] = await sql<{ id: string; sim: number }[]>`
      select id, 1 - (centroid operator(extensions.<=>) ${v}::extensions.vector) as sim
      from public.gap_topics
      where agent_id = ${r.agent_id} and kind = ${r.kind} and centroid is not null
      order by centroid operator(extensions.<=>) ${v}::extensions.vector limit 1`;
    let topicId = near && near.sim >= GAP_SIMILARITY ? near.id : null;
    if (!topicId) {
      const [t] = await sql<{ id: string }[]>`
        insert into public.gap_topics (agent_id, kind, title, category, centroid)
        values (${r.agent_id}, ${r.kind}, ${r.text}, ${r.category}, ${v}::extensions.vector)
        returning id`;
      topicId = t!.id;
    }
    await sql`update public.gaps set embedding = ${v}::extensions.vector, topic_id = ${topicId} where id = ${r.id}`;
    touched.add(topicId);
  }
  for (const id of touched) await refreshTopic(id);
  await nameTopics([...touched]).catch((e) => log.warn({ err: String(e) }, "lacunas: título dos temas falhou"));
  return rows.length;
}

/** Temas com algumas ocorrências ganham um título curto escrito pela MAVI. */
async function nameTopics(ids: string[]) {
  if (!ids.length) return;
  const sql = db();
  const topics = await sql<{ id: string; agent_id: string; kind: GapKind }[]>`
    select id, agent_id, kind from public.gap_topics
    where id in ${sql(ids)} and title_source = 'first' and occurrences >= ${NAME_AT}`;
  for (const t of topics) {
    const samples = await sql<{ text: string }[]>`
      select text from public.gaps where topic_id = ${t.id} order by id desc limit 12`;
    const r = await chat({
      model: config().UTILITY_MODEL,
      keys: await agentKeys(t.agent_id),
      json: true,
      effort: "low",
      maxTokens: 1500,
      timeoutMs: 30_000,
      messages: [
        {
          role: "system",
          content:
            `Dê um título curto (até 8 palavras, em português) que represente estas ${t.kind === "objection" ? "objeções" : "perguntas"} de leads, ` +
            `escrito como o lead diria${t.kind === "question" ? " (uma pergunta)" : ""}. Responda só JSON: {"titulo": "..."}.`,
        },
        { role: "user", content: samples.map((s) => `- ${s.text}`).join("\n") },
      ],
    });
    const title = String((JSON.parse(r.message.content ?? "{}") as { titulo?: unknown }).titulo ?? "").trim().slice(0, 200);
    if (title) await sql`update public.gap_topics set title = ${title}, title_source = 'mavi', updated_at = now() where id = ${t.id} and title_source = 'first'`;
  }
}

/** Junta um tema em outro (a pessoa viu que são a mesma coisa). */
export async function mergeTopics(fromId: string, intoId: string) {
  await db()`update public.gaps set topic_id = ${intoId} where topic_id = ${fromId}`;
  await db()`delete from public.gap_topics where id = ${fromId}`;
  await refreshTopic(intoId);
}

// ---------------------------------------------------------------- sugestão de resposta

async function agentSpec(agentId: string): Promise<AgentSpec | null> {
  const p = await publishedSpec(agentId).catch(() => null);
  if (p) return p.spec;
  const [a] = await db()<{ draft: unknown }[]>`select draft from public.agents where id = ${agentId}`;
  const parsed = parseSpec(a?.draft);
  return parsed.ok ? parsed.spec : null;
}

/** Como a equipe respondeu no MakeCRM logo depois (quando uma pessoa entrou na conversa). */
async function teamAnswers(examples: { external_id: string; mavi_user_id: string | null; created_at: Date; simulation: boolean }[]): Promise<string[]> {
  const out: string[] = [];
  for (const ex of examples.filter((e) => !e.simulation).slice(0, 4)) {
    try {
      const since = new Date(ex.created_at.getTime() - 60_000).toISOString();
      const until = new Date(ex.created_at.getTime() + 24 * 3600_000).toISOString();
      const rows = await rest<{ content: string | null; user_id: string | null }[]>(
        `inbox_messages?select=content,user_id&conversation_id=eq.${encodeURIComponent(ex.external_id)}` +
          `&message_type=eq.outcoming&private=eq.false&user_id=not.is.null` +
          `&created_at=gte.${encodeURIComponent(since)}&created_at=lte.${encodeURIComponent(until)}&order=created_at.asc&limit=6`,
      );
      const texts = rows.filter((r) => r.user_id !== ex.mavi_user_id && r.content?.trim()).map((r) => r.content!.trim());
      if (texts.length) out.push(texts.join("\n").slice(0, 1200));
    } catch (e) {
      log.warn({ err: String(e) }, "lacunas: não leu as respostas da equipe no MakeCRM");
    }
  }
  return out;
}

export type GapSuggestion = { question: string; answer: string; note: string; sources: string[]; model: string; generated_at: string; cost_usd: number };

export async function suggestForTopic(topicId: string): Promise<GapSuggestion> {
  const sql = db();
  const [t] = await sql<{ id: string; agent_id: string; kind: GapKind; title: string; category: string }[]>`
    select id, agent_id, kind, title, category from public.gap_topics where id = ${topicId}`;
  if (!t) throw new Error("Tema não encontrado.");
  const spec = await agentSpec(t.agent_id);
  const examples = await sql<{ text: string; lead_text: string; external_id: string; mavi_user_id: string | null; created_at: Date; simulation: boolean }[]>`
    select g.text, g.lead_text, c.external_id, c.mavi_user_id, g.created_at, c.simulation
    from public.gaps g join public.conversations c on c.id = g.conversation_id
    where g.topic_id = ${t.id} order by g.id desc limit 8`;
  const kb = await searchKnowledge({ agentId: t.agent_id, query: t.title, k: 6 }).catch(() => ({ results: [] }));
  const team = await teamAnswers(examples);
  const sources = [
    ...(kb.results.length ? ["conhecimento do agente"] : []),
    ...(team.length ? [`resposta da equipe (${team.length})`] : []),
    ...(spec?.persona.company_summary ? ["perfil da empresa"] : []),
  ];
  const objection = t.kind === "objection";
  const model = spec?.model.model ?? config().DEFAULT_MODEL;
  const r = await chat({
    model,
    keys: await agentKeys(t.agent_id),
    pricing: spec?.model.pricing ?? null,
    json: true,
    effort: "low",
    maxTokens: 4000,
    timeoutMs: 90_000,
    messages: [
      {
        role: "system",
        content: [
          `Você escreve um item de treinamento para o agente de WhatsApp ${spec ? `"${spec.persona.name}" da empresa ${spec.persona.company}` : ""}.`,
          objection
            ? "Leads fizeram a objeção abaixo e o agente não tinha orientação. Escreva como o agente deve contornar: argumentos, o que perguntar e o próximo passo."
            : "Leads fizeram a pergunta abaixo e o agente não tinha a resposta. Escreva a resposta que o agente deve dar.",
          "Use só fatos do material, das respostas da equipe e do perfil da empresa. Não invente preços, prazos, condições nem políticas.",
          "Se faltar um dado, escreva a resposta com [PREENCHER: o que falta] no lugar e diga em observacao o que precisa ser confirmado.",
          "Tom de WhatsApp, curto e natural, em português do Brasil.",
          'Responda só JSON: {"pergunta": "...", "resposta": "...", "observacao": "..."}.',
          objection ? 'Em "pergunta", use: "Quando o lead diz: <objeção>".' : 'Em "pergunta", a pergunta como o lead faria.',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `${objection ? "Objeção" : "Pergunta"}: ${t.title}${t.category ? ` (categoria: ${t.category})` : ""}`,
          `Como os leads disseram:\n${examples.map((e) => `- ${e.lead_text ? e.lead_text.slice(0, 300) : e.text}`).join("\n")}`,
          spec?.persona.company_summary ? `Perfil da empresa:\n${spec.persona.company_summary.slice(0, 3000)}` : "",
          kb.results.length ? `Material do agente:\n${kb.results.map((x) => `- ${x.title ? `${x.title}: ` : ""}${x.content.slice(0, 700)}`).join("\n")}` : "Material do agente: (nada encontrado)",
          team.length ? `Como a equipe respondeu nessas conversas:\n${team.map((x) => `---\n${x}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  const j = JSON.parse(r.message.content ?? "{}") as { pergunta?: unknown; resposta?: unknown; observacao?: unknown };
  const suggestion: GapSuggestion = {
    question: String(j.pergunta ?? t.title).trim().slice(0, 300) || t.title,
    answer: String(j.resposta ?? "").trim().slice(0, 4000),
    note: String(j.observacao ?? "").trim().slice(0, 1000),
    sources,
    model: r.model,
    generated_at: new Date().toISOString(),
    cost_usd: r.usage.costUsd,
  };
  await sql`update public.gap_topics set suggestion = ${sql.json(suggestion as never)}, updated_at = now() where id = ${t.id}`;
  return suggestion;
}

/** A resposta aprovada entra no conhecimento (pergunta frequente) e o tema fica "treinado". */
export async function applyToTraining(topicId: string, input: { question: string; answer: string; by: string }): Promise<string> {
  const sql = db();
  const [t] = await sql<{ id: string; agent_id: string; kind: GapKind }[]>`select id, agent_id, kind from public.gap_topics where id = ${topicId}`;
  if (!t) throw new Error("Tema não encontrado.");
  const data = { question: input.question, answer: input.answer, origin: "gap", gap_topic_id: t.id, objection: t.kind === "objection" };
  const [item] = await sql<{ id: string }[]>`
    insert into public.knowledge_items (agent_id, kind, title, body, data, source, created_by)
    values (${t.agent_id}, 'faq', ${input.question.slice(0, 300)}, ${input.answer}, ${sql.json(data as never)},
            ${sql.json({ type: "text", origin: "gap" } as never)}, ${input.by})
    returning id`;
  await scheduleIngest(item!.id);
  await sql`
    update public.gap_topics set status = 'trained', trained_at = now(), trained_by = ${input.by},
      knowledge_item_id = ${item!.id}, after_trained = 0, updated_at = now()
    where id = ${t.id}`;
  return item!.id;
}
