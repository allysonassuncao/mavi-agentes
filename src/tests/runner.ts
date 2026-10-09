import { config } from "../config.js";
import { db } from "../db.js";
import { recordCost } from "../costs/ledger.js";
import { searchKnowledge } from "../knowledge/search.js";
import { chat, type ChatMessage } from "../llm/client.js";
import { log } from "../log.js";
import { parseGaps, recordGaps, type GapDraft } from "../insights/gap-capture.js";
import { OUTCOMES } from "../insights/analyze.js";
import { runTurn } from "../runtime/turn.js";
import { agentKeys } from "../secrets.js";
import { parseSpec, type AgentSpec } from "../spec/agent.js";

/**
 * Testes com leads simulados. Uma bateria: a MAVI cria perfis de lead pelo
 * contexto do agente (interessado, cético, preço, fora do perfil…), cada
 * perfil conversa com o agente (simulação: nada vai ao WhatsApp), um avaliador
 * lê a conversa (nota, objetivo, problemas, lacunas) e, no fim, a MAVI diz o
 * que melhorar. Teto de custo por bateria; as lacunas vão para as Lacunas
 * com origem "teste".
 */

export const PROFILES: Record<string, { label: string; hint: string }> = {
  interessado: { label: "Interessado", hint: "Quer resolver logo e está pronto para avançar" },
  desinteressado: { label: "Desinteressado", hint: "Respondeu por curiosidade, pouco interesse" },
  cetico: { label: "Cético", hint: "Desconfiado, quer provas, garantias e casos" },
  preco: { label: "Objeção de preço", hint: "Acha caro, pede desconto, compara valores" },
  apressado: { label: "Apressado", hint: "Mensagens curtas, quer tudo rápido" },
  confuso: { label: "Confuso", hint: "Não entende bem o serviço, perguntas vagas" },
  comparando: { label: "Comparando", hint: "Está avaliando concorrentes" },
  indeciso: { label: "Indeciso", hint: "Gosta, mas adia a decisão" },
  fora_do_perfil: { label: "Fora do perfil", hint: "Procura outra coisa, não é o público" },
  fora_do_assunto: { label: "Fora do assunto", hint: "Pergunta coisas fora do escopo da empresa" },
  dificil: { label: "Difícil", hint: "Impaciente ou grosseiro" },
  ja_cliente: { label: "Já é cliente", hint: "Quer suporte ou tem um problema" },
};

export type Persona = {
  nome: string;
  perfil: string;
  descricao: string;
  objetivo: string;
  conhece: string;
  objecoes: string[];
  estilo: string;
  fim_quando: string;
};

export const TEST_ISSUES = ["wrong_info", "ignored_question", "repetition", "overpromise", "tone", "missed_handoff", "rule_violation", "off_script", "other"] as const;

export type Verdict = {
  score: number;
  goal_reached: boolean;
  outcome: string;
  issues: { type: string; severity: number; detail: string; quote: string }[];
  gaps: GapDraft[];
  strengths: string[];
  summary: string;
};

type RunRow = {
  id: string;
  agent_id: string;
  kind: string;
  agent_version: number | null;
  spec: unknown;
  compare_to: string | null;
  profiles: string[];
  focus: string;
  personas: Persona[];
  conversations: number;
  max_turns: number;
  cost_cap_usd: string;
  status: string;
};

const clip = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const json = (text: string | null) => {
  try {
    return JSON.parse(text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

async function loadRun(id: string): Promise<RunRow | null> {
  const [r] = await db()<RunRow[]>`select * from public.test_runs where id = ${id}`;
  return r ?? null;
}

/** O que a bateria já gastou: as conversas dela e o que é da bateria (perfis, conclusão). */
export async function runCost(runId: string): Promise<number> {
  const [r] = await db()<{ c: number }[]>`
    select coalesce(sum(e.cost_usd), 0)::float8 as c from public.cost_events e
    where e.conversation_id in (select tc.conversation_id from public.test_conversations tc where tc.run_id = ${runId} and tc.conversation_id is not null)
       or e.meta->>'test_run' = ${runId}::text`;
  return r?.c ?? 0;
}

function specOf(run: RunRow): AgentSpec {
  const r = parseSpec(run.spec);
  if (!r.ok) throw new Error("A especificação testada é inválida.");
  return r.spec;
}

/** O resumo do agente que o lead simulado e o avaliador conhecem. */
function agentBrief(spec: AgentSpec) {
  const ins = spec.instructions;
  return [
    `Empresa: ${spec.persona.company}${spec.persona.segment ? ` (${spec.persona.segment})` : ""}`,
    spec.persona.company_summary ? `Sobre a empresa: ${spec.persona.company_summary.slice(0, 2500)}` : "",
    `Objetivo do agente: ${ins.goal.slice(0, 1500)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- perfis

export function parsePersonas(raw: unknown, n: number): Persona[] {
  const list = Array.isArray((raw as { personas?: unknown })?.personas) ? ((raw as { personas: unknown[] }).personas) : [];
  return list
    .map((p) => {
      const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      return {
        nome: clip(o.nome, 60) || "Lead",
        perfil: PROFILES[String(o.perfil)] ? String(o.perfil) : "interessado",
        descricao: clip(o.descricao, 600),
        objetivo: clip(o.objetivo, 400),
        conhece: clip(o.conhece, 300),
        objecoes: (Array.isArray(o.objecoes) ? o.objecoes : []).map((x) => clip(x, 200)).filter(Boolean).slice(0, 4),
        estilo: clip(o.estilo, 200),
        fim_quando: clip(o.fim_quando, 300),
      };
    })
    .filter((p) => p.descricao && p.objetivo)
    .slice(0, n);
}

async function makePersonas(run: RunRow, spec: AgentSpec): Promise<Persona[]> {
  const chosen = run.profiles.filter((p) => PROFILES[p]);
  const r = await chat({
    model: config().UTILITY_MODEL,
    keys: await agentKeys(run.agent_id),
    json: true,
    effort: "low",
    maxTokens: 6000,
    timeoutMs: 120_000,
    messages: [
      {
        role: "system",
        content: [
          "Você cria perfis de leads (clientes em potencial) para testar um agente de atendimento no WhatsApp antes de ir para produção.",
          "O objetivo é achar o que o treinamento do agente NÃO cobre: perguntas específicas, situações de borda, objeções reais do segmento, pedidos fora do roteiro.",
          "Perfis variados e realistas para o público do Brasil; nomes brasileiros; cada um com um objetivo concreto e detalhes que obriguem o agente a saber coisas da empresa.",
          `Tipos de perfil possíveis: ${Object.entries(PROFILES).map(([k, v]) => `${k} (${v.hint})`).join("; ")}.`,
          'Responda só JSON: {"personas": [{"nome": "...", "perfil": "<tipo>", "descricao": "quem é, contexto, situação", "objetivo": "o que quer da conversa", "conhece": "o que já sabe da empresa", "objecoes": ["..."], "estilo": "como escreve no WhatsApp", "fim_quando": "quando encerra a conversa"}]}',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          agentBrief(spec),
          spec.instructions.conversation_guide ? `Roteiro do agente (trecho): ${spec.instructions.conversation_guide.slice(0, 2000)}` : "",
          `Crie ${run.conversations} perfis${chosen.length ? `, distribuídos entre: ${chosen.join(", ")}` : ", escolhendo a melhor mistura para achar falhas"}.`,
          run.focus ? `Foco pedido por quem testa: ${run.focus}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  await recordCost({ agentId: run.agent_id, source: "test_persona", simulation: true, usage: r.usage, model: r.model, meta: { test_run: run.id } });
  const personas = parsePersonas(json(r.message.content), run.conversations);
  if (!personas.length) throw new Error("A MAVI não conseguiu criar os perfis dos leads.");
  return personas;
}

// ---------------------------------------------------------------- o lead simulado

/** A próxima fala do lead (o histórico visto do lado dele: o agente é "user"). */
async function leadSays(run: RunRow, spec: AgentSpec, p: Persona, history: { role: "user" | "assistant"; content: string }[], conversationId: string) {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        `Você é ${p.nome}, um lead conversando pelo WhatsApp com o atendimento de ${spec.persona.company}. Fique no personagem: nunca diga que é IA, robô ou teste.`,
        `Quem você é: ${p.descricao}`,
        `O que você quer: ${p.objetivo}`,
        p.conhece ? `O que você já sabe: ${p.conhece}` : "",
        p.objecoes.length ? `Objeções que você tem (use quando fizer sentido): ${p.objecoes.join("; ")}` : "",
        `Como você escreve: ${p.estilo || "curto, informal, como uma pessoa comum no WhatsApp"}. Às vezes erros de digitação; poucos emojis.`,
        `Encerre (fim: true) quando: ${p.fim_quando || "conseguir o que queria, desistir ou a conversa não avançar"}. Também encerre se o atendimento disser que uma pessoa vai continuar.`,
        "Reaja ao que o atendente disse de verdade: se ele não respondeu sua pergunta, insista ou reclame; se inventou algo, desconfie.",
        'Responda só JSON: {"mensagens": ["1 ou 2 mensagens curtas"], "fim": false}. Se for encerrar sem dizer nada, mensagens vazio.',
      ]
        .filter(Boolean)
        .join("\n"),
    },
    ...(history.length
      ? history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage)
      : [{ role: "user", content: "(Comece a conversa: a sua primeira mensagem para a empresa.)" } as ChatMessage]),
  ];
  const r = await chat({ model: config().UTILITY_MODEL, keys: await agentKeys(run.agent_id), json: true, effort: "low", maxTokens: 1500, timeoutMs: 60_000, messages });
  await recordCost({ agentId: run.agent_id, conversationId, source: "test_lead", simulation: true, usage: r.usage, model: r.model, meta: { test_run: run.id } });
  const j = json(r.message.content);
  const texts = (Array.isArray(j.mensagens) ? j.mensagens : []).map((x) => clip(x, 600)).filter(Boolean).slice(0, 2);
  return { texts, end: j.fim === true };
}

// ---------------------------------------------------------------- avaliação

export function parseVerdict(raw: Record<string, unknown>): Verdict {
  const score = Math.max(0, Math.min(10, Math.round(Number(raw.nota) || 0)));
  const outcome = (OUTCOMES as readonly string[]).includes(String(raw.resultado)) ? String(raw.resultado) : "other";
  const issues = (Array.isArray(raw.problemas) ? raw.problemas : [])
    .map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      return {
        type: (TEST_ISSUES as readonly string[]).includes(String(o.tipo)) ? String(o.tipo) : "other",
        severity: Math.max(1, Math.min(3, Math.round(Number(o.gravidade) || 1))),
        detail: clip(o.detalhe, 400),
        quote: clip(o.trecho, 300),
      };
    })
    .filter((x) => x.detail)
    .slice(0, 8);
  return {
    score,
    goal_reached: raw.objetivo_atingido === true,
    outcome,
    issues,
    gaps: parseGaps(raw.lacunas),
    strengths: (Array.isArray(raw.pontos_fortes) ? raw.pontos_fortes : []).map((x) => clip(x, 200)).filter(Boolean).slice(0, 4),
    summary: clip(raw.resumo, 600),
  };
}

async function judge(run: RunRow, spec: AgentSpec, p: Persona, transcript: string, leadText: string, conversationId: string): Promise<Verdict> {
  const kb = await searchKnowledge({ agentId: run.agent_id, query: leadText.slice(0, 2000), k: 6 }).catch(() => ({ results: [] }));
  const ins = spec.instructions;
  const r = await chat({
    model: config().DEFAULT_MODEL,
    keys: await agentKeys(run.agent_id),
    json: true,
    effort: "low",
    maxTokens: 4000,
    timeoutMs: 120_000,
    messages: [
      {
        role: "system",
        content: [
          "Você avalia uma conversa de teste entre um agente de atendimento no WhatsApp e um lead simulado. Seja exigente e justo, em português.",
          "Aponte: informação errada ou inventada (compare com o material), pergunta sem resposta, repetição, promessa indevida, tom inadequado, não passou para a equipe quando devia, quebrou uma regra, saiu do roteiro.",
          "Lacunas: perguntas ou objeções do lead que o agente não soube responder com base no material (escreva genérico, sem nomes).",
          'Responda só JSON: {"nota": 0-10, "objetivo_atingido": true|false, "resultado": "scheduled|purchased|qualified|handed_off|in_progress|not_interested|ghosted|disqualified|other",',
          ' "problemas": [{"tipo": "wrong_info|ignored_question|repetition|overpromise|tone|missed_handoff|rule_violation|off_script|other", "gravidade": 1-3, "detalhe": "...", "trecho": "o que o agente disse"}],',
          ' "lacunas": [{"tipo": "pergunta|objecao", "texto": "..."}], "pontos_fortes": ["..."], "resumo": "uma frase"}',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          agentBrief(spec),
          ins.rules.length ? `Regras do agente:\n- ${ins.rules.join("\n- ")}` : "",
          ins.never.length ? `O agente nunca deve:\n- ${ins.never.join("\n- ")}` : "",
          spec.handoff.enabled && spec.handoff.when ? `Quando passar para uma pessoa: ${spec.handoff.when}` : "",
          kb.results.length ? `Material do agente (trechos):\n${kb.results.map((x) => `- ${x.title ? `${x.title}: ` : ""}${x.content.slice(0, 600)}`).join("\n")}` : "Material do agente: (nada encontrado sobre o assunto)",
          `Lead simulado (${PROFILES[p.perfil]?.label ?? p.perfil}): ${p.descricao} Objetivo: ${p.objetivo}`,
          `Conversa:\n${transcript.slice(-20_000)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  await recordCost({ agentId: run.agent_id, conversationId, source: "test_judge", simulation: true, usage: r.usage, model: r.model, meta: { test_run: run.id } });
  return parseVerdict(json(r.message.content));
}

// ---------------------------------------------------------------- a bateria

/** Começa a bateria (e a do par, antes de publicar): perfis e conversas na fila. */
export async function startRun(runId: string, enqueue: (runId: string, idx: number) => Promise<void>) {
  const sql = db();
  const run = await loadRun(runId);
  if (!run || run.status !== "queued") return;
  await sql`update public.test_runs set status = 'running', started_at = now() where id in (${run.id}, ${run.compare_to ?? run.id}) and status = 'queued'`;
  try {
    const personas = run.personas.length ? run.personas : await makePersonas(run, specOf(run));
    const ids = [run.id, ...(run.compare_to ? [run.compare_to] : [])];
    for (const id of ids) {
      await sql`update public.test_runs set personas = ${sql.json(personas as never)}, conversations = ${personas.length} where id = ${id}`;
      for (let i = 0; i < personas.length; i++)
        await sql`insert into public.test_conversations (run_id, idx, persona) values (${id}, ${i}, ${sql.json(personas[i] as never)}) on conflict do nothing`;
      for (let i = 0; i < personas.length; i++) await enqueue(id, i);
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error({ runId, err }, "testes: não começou");
    await sql`update public.test_runs set status = 'error', error = ${err.slice(0, 1000)}, finished_at = now() where id in (${run.id}, ${run.compare_to ?? run.id})`;
  }
}

export async function runConversation(runId: string, idx: number): Promise<string> {
  const sql = db();
  const run = await loadRun(runId);
  if (!run) return "sem bateria";
  const [tc] = await sql<{ id: string; persona: Persona; status: string }[]>`
    select id, persona, status from public.test_conversations where run_id = ${runId} and idx = ${idx}`;
  if (!tc || tc.status !== "queued") return "já feita";
  if (run.status !== "running") {
    await sql`update public.test_conversations set status = 'skipped', finished_at = now() where id = ${tc.id}`;
    await finishIfDone(runId);
    return "bateria parada";
  }
  const cap = Number(run.cost_cap_usd);
  if ((await runCost(runId)) >= cap) {
    await stopRun(runId, "teto de custo da bateria");
    await sql`update public.test_conversations set status = 'skipped', finished_at = now() where id = ${tc.id}`;
    await finishIfDone(runId);
    return "teto";
  }
  await sql`update public.test_conversations set status = 'running' where id = ${tc.id}`;
  const spec = specOf(run);
  const p = tc.persona;
  try {
    const [agent] = await sql<{ company_id: string }[]>`select company_id from public.agents where id = ${run.agent_id}`;
    const [conv] = await sql<{ id: string }[]>`
      insert into public.conversations (agent_id, company_id, external_id, simulation, contact_name, phone)
      values (${run.agent_id}, ${agent!.company_id}, ${`test:${runId}:${idx}`}, true, ${p.nome}, '5500000000000')
      on conflict (agent_id, simulation, external_id) do update set contact_name = excluded.contact_name
      returning id`;
    const conversationId = conv!.id;
    await sql`update public.test_conversations set conversation_id = ${conversationId} where id = ${tc.id}`;

    // Visto do lado do lead: o que o agente diz é "user", o que o lead diz é "assistant".
    const leadHistory: { role: "user" | "assistant"; content: string }[] = [];
    const lines: string[] = [];
    let turns = 0;
    let gaps: GapDraft[] = [];
    for (let t = 0; t < run.max_turns; t++) {
      const said = await leadSays(run, spec, p, leadHistory, conversationId);
      if (!said.texts.length) break;
      for (const text of said.texts) {
        await sql`insert into public.messages (conversation_id, role, content) values (${conversationId}, 'user', ${text})`;
        lines.push(`Lead: ${text}`);
      }
      leadHistory.push({ role: "assistant", content: said.texts.join("\n") });
      const r = await runTurn({ conversationId, spec, agentVersion: run.agent_version });
      turns++;
      if (r.status === "error") throw new Error(`O agente falhou: ${r.error ?? "erro"}`);
      const reply = r.messages.map((m) => m.text).join("\n");
      if (reply) {
        lines.push(`Agente: ${reply}`);
        leadHistory.push({ role: "user", content: reply });
      }
      if (r.turnId) {
        const [tr] = await sql<{ output: { gaps?: unknown } | null }[]>`select output from public.turns where id = ${r.turnId}`;
        gaps = gaps.concat(parseGaps(tr?.output?.gaps));
      }
      if (said.end || r.handoff) break;
      if ((await runCost(runId)) >= cap) {
        await stopRun(runId, "teto de custo da bateria");
        break;
      }
      const [fresh] = await sql<{ status: string }[]>`select status from public.test_runs where id = ${runId}`;
      if (fresh?.status !== "running") break;
    }
    const transcript = lines.join("\n");
    const leadText = lines.filter((l) => l.startsWith("Lead:")).join("\n");
    const verdict = turns ? await judge(run, spec, p, transcript, leadText, conversationId) : null;
    // Lacunas: o que o agente avisou + o que o avaliador viu (sem repetir).
    const all = [...gaps, ...(verdict?.gaps ?? [])].filter((g, i, a) => a.findIndex((x) => x.text.toLowerCase() === g.text.toLowerCase()) === i);
    if (all.length) await recordGaps({ agentId: run.agent_id, conversationId, turnId: null, leadText: leadText.slice(0, 1000), gaps: all, origin: "test" });
    const [cost] = await sql<{ c: number }[]>`select coalesce(sum(cost_usd), 0)::float8 as c from public.cost_events where conversation_id = ${conversationId}`;
    await sql`
      update public.test_conversations set status = ${verdict ? "done" : "skipped"}, turns = ${turns},
        verdict = ${verdict ? sql.json({ ...verdict, gaps: all } as never) : null}, cost_usd = ${cost?.c ?? 0}, finished_at = now()
      where id = ${tc.id}`;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.warn({ runId, idx, err }, "testes: conversa falhou");
    await sql`update public.test_conversations set status = 'error', error = ${err.slice(0, 1000)}, finished_at = now() where id = ${tc.id}`;
  }
  await finishIfDone(runId);
  return "feita";
}

export async function stopRun(runId: string, reason: string) {
  await db()`update public.test_runs set status = 'stopped', stop_reason = ${reason} where id = ${runId} and status in ('queued', 'running')`;
}

/** As contas da bateria quando a última conversa termina (uma vez só). */
export function summarize(convs: { status: string; verdict: Verdict | null }[]) {
  const done = convs.filter((c) => c.verdict);
  const issues: Record<string, { n: number; examples: string[] }> = {};
  const outcomes: Record<string, number> = {};
  for (const c of done) {
    const v = c.verdict!;
    outcomes[v.outcome] = (outcomes[v.outcome] ?? 0) + 1;
    for (const i of v.issues) {
      issues[i.type] ??= { n: 0, examples: [] };
      issues[i.type]!.n++;
      if (issues[i.type]!.examples.length < 3) issues[i.type]!.examples.push(i.detail);
    }
  }
  return {
    conversations: convs.length,
    evaluated: done.length,
    errors: convs.filter((c) => c.status === "error").length,
    score: done.length ? Math.round((done.reduce((s, c) => s + c.verdict!.score, 0) / done.length) * 10) / 10 : null,
    goal_rate: done.length ? done.filter((c) => c.verdict!.goal_reached).length / done.length : null,
    outcomes,
    issues,
    gaps: done.reduce((s, c) => s + c.verdict!.gaps.length, 0),
    severe: done.reduce((s, c) => s + c.verdict!.issues.filter((i) => i.severity >= 3).length, 0),
  };
}

export async function finishIfDone(runId: string) {
  const sql = db();
  // Só quem fecha a última conversa conclui (a trava é a mudança de status).
  const [left] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.test_conversations where run_id = ${runId} and status in ('queued', 'running')`;
  if (left!.n > 0) return;
  const [claimed] = await sql<{ id: string; was: string }[]>`
    update public.test_runs r set summary = '{"concluding": true}'::jsonb
    where r.id = ${runId} and r.summary is null and r.status in ('running', 'stopped')
    returning r.id, r.status as was`;
  if (!claimed) return;
  const run = (await loadRun(runId))!;
  const convs = await sql<{ status: string; verdict: Verdict | null; persona: Persona }[]>`
    select status, verdict, persona from public.test_conversations where run_id = ${runId} order by idx`;
  const summary: Record<string, unknown> = summarize(convs);
  try {
    const done = convs.filter((c) => c.verdict);
    if (done.length) {
      const r = await chat({
        model: config().UTILITY_MODEL,
        keys: await agentKeys(run.agent_id),
        json: true,
        effort: "low",
        maxTokens: 3000,
        timeoutMs: 90_000,
        messages: [
          {
            role: "system",
            content:
              'Você resume uma bateria de testes de um agente de WhatsApp com leads simulados para quem cuida dele. Em português, direto. Responda só JSON: {"conclusao": "2 a 3 frases", "acoes": [{"titulo": "curto", "texto": "o que mudar e por quê", "onde": "instrucoes|conhecimento|comportamento|integracoes"}]} com até 5 ações, das mais importantes para as menos.',
          },
          {
            role: "user",
            content: done
              .map(
                (c, i) =>
                  `Conversa ${i + 1} (${PROFILES[c.persona.perfil]?.label ?? c.persona.perfil}): nota ${c.verdict!.score}, objetivo ${c.verdict!.goal_reached ? "atingido" : "não atingido"}. ${c.verdict!.summary}\n` +
                  c.verdict!.issues.map((x) => `- ${x.type} (gravidade ${x.severity}): ${x.detail}`).join("\n") +
                  (c.verdict!.gaps.length ? `\nLacunas: ${c.verdict!.gaps.map((g) => g.text).join("; ")}` : ""),
              )
              .join("\n\n"),
          },
        ],
      });
      await recordCost({ agentId: run.agent_id, source: "test_judge", simulation: true, usage: r.usage, model: r.model, meta: { test_run: runId, step: "conclusao" } });
      const j = json(r.message.content);
      summary.conclusion = clip(j.conclusao, 1200);
      summary.actions = (Array.isArray(j.acoes) ? j.acoes : [])
        .map((a) => {
          const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
          return { title: clip(o.titulo, 120), text: clip(o.texto, 600), where: clip(o.onde, 20) };
        })
        .filter((a) => a.title)
        .slice(0, 5);
    }
  } catch (e) {
    log.warn({ runId, err: String(e) }, "testes: conclusão falhou");
  }
  const cost = await runCost(runId);
  await sql`
    update public.test_runs set summary = ${sql.json(summary as never)}, cost_usd = ${cost},
      status = case when status = 'stopped' then 'stopped' else 'done' end, finished_at = now()
    where id = ${runId}`;
}
