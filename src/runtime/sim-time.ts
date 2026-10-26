import { db } from "../db.js";
import { spLabel } from "../integrations/time.js";
import type { AgentSpec } from "../spec/agent.js";
import { callbacksOn, describeActions, type CallbackRow } from "./callbacks.js";
import { trackSteps } from "./followup-track.js";
import { writeFollowupAi } from "./followup.js";
import { cleanText } from "./output.js";
import { teamEventText, teamOn, type TeamQuestionRow } from "./team.js";
import { runTurn, type ConversationRow, type TurnResult } from "./turn.js";

/**
 * "Avançar o tempo" do Testar: o que depende do tempo (follow-up, retorno
 * combinado, sem resposta da equipe) não sai sozinho nas conversas de teste;
 * o simulador mostra o que está agendado e faz o próximo acontecer agora, com
 * as mesmas regras do real. Nada sai para o WhatsApp nem muda no CRM.
 */

export type SimItem = { kind: "followup" | "callback" | "team"; id: string; at: string; label: string };

/** O que está agendado nesta conversa de teste, do mais próximo ao mais distante. */
export async function simSchedule(conv: ConversationRow & { followup_state?: string; followup_next_at?: Date | null; followup_step?: number; followup_track?: string | null }, spec: AgentSpec): Promise<SimItem[]> {
  const sql = db();
  const items: SimItem[] = [];
  const fu = spec.followup;
  if (fu?.enabled && conv.followup_state === "active" && conv.followup_next_at) {
    const steps = trackSteps(fu, conv.followup_track);
    const step = conv.followup_step ?? 0;
    if (steps[step]) items.push({ kind: "followup", id: String(step), at: conv.followup_next_at.toISOString(), label: `Follow-up ${step + 1} de ${steps.length}` });
  }
  if (callbacksOn(spec)) {
    const cbs = await sql<CallbackRow[]>`select * from public.agent_callbacks where conversation_id = ${conv.id} and status = 'scheduled' order by due_at`;
    for (const cb of cbs) items.push({ kind: "callback", id: cb.id, at: cb.due_at.toISOString(), label: `Retorno combinado (${spLabel(cb.due_at)})` });
  }
  if (teamOn(spec)) {
    const qs = await sql<TeamQuestionRow[]>`select * from public.team_questions where conversation_id = ${conv.id} and status = 'open' order by asked_at`;
    const t = spec.team_questions.timeout;
    const what = t.action === "remind" ? "lembrar a equipe" : t.action === "handoff" ? "passar para uma pessoa" : "o agente avisa que não conseguiu confirmar";
    for (const q of qs) {
      if (t.action === "remind" && q.reminders >= t.max_reminders) continue;
      const at = new Date(q.asked_at.getTime() + (q.reminders + 1) * t.minutes * 60_000);
      items.push({ kind: "team", id: q.id, at: at.toISOString(), label: `Sem resposta da equipe #${q.code}: ${what}` });
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

export type SimAdvance = { item: SimItem | null; note: string; result: TurnResult | null; turn: unknown };

const note = (conversationId: string, content: string) =>
  db()`insert into public.messages (conversation_id, role, content) values (${conversationId}, 'note', ${content.slice(0, 2000)})`;

/** Faz o próximo item agendado acontecer agora (só em conversa de teste). */
export async function advanceSim(conv: ConversationRow & Record<string, unknown>, spec: AgentSpec, version: number | null): Promise<SimAdvance> {
  if (!conv.simulation) throw new Error("Só em conversa de teste.");
  const sql = db();
  const [item] = await simSchedule(conv as never, spec);
  if (!item) return { item: null, note: "Nada agendado nesta conversa.", result: null, turn: null };

  if (item.kind === "followup") {
    const fu = spec.followup!;
    const steps = trackSteps(fu, conv.followup_track as string | null);
    const step = Number(item.id);
    const s = steps[step]!;
    const [t] = await sql<{ id: string }[]>`select gen_random_uuid() as id`;
    const vars = { nome: conv.contact_name ?? "", primeiro_nome: (conv.contact_name ?? "").split(/\s+/)[0] ?? "", agente: spec.persona.name, empresa: spec.persona.company };
    const fill = (x: string) => x.replace(/\{(nome|primeiro_nome|agente|empresa)\}/g, (_, k: keyof typeof vars) => vars[k] ?? "");
    let texts: string[] = [];
    let usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0 };
    let model: string | null = null;
    if (s.mode === "fixed") texts = [cleanText(fill(s.text), spec)];
    else {
      const r = await writeFollowupAi(spec, conv, step, steps.length, s, t!.id);
      texts = r.texts;
      usage = r.usage;
      model = r.model;
    }
    const next = steps[step + 1];
    await sql.begin(async (tx) => {
      for (const x of texts)
        await tx`insert into public.messages (conversation_id, role, content, turn_id, meta) values (${conv.id}, 'assistant', ${x}, ${t!.id}, ${tx.json({ followup: step } as never)})`;
      await tx`
        insert into public.turns (id, conversation_id, agent_id, agent_version, simulation, status, model, tokens_in, tokens_out, tokens_cached, cost_usd, output)
        values (${t!.id}, ${conv.id}, ${conv.agent_id}, ${version}, true, ${texts.length ? "done" : "skipped"}, ${model},
                ${usage.tokensIn}, ${usage.tokensOut}, ${usage.tokensCached}, ${usage.costUsd},
                ${tx.json({ followup: step, messages: texts.map((x) => ({ text: x, media: [] })), note: texts.length ? null : "a IA decidiu não retomar agora" } as never)})`;
      if (next)
        await tx`update public.conversations set followup_step = ${step + 1}, followup_next_at = now() + make_interval(mins => ${next.after_minutes}) where id = ${conv.id}`;
      else await tx`update public.conversations set followup_step = ${step + 1}, followup_state = 'done', followup_next_at = null where id = ${conv.id}`;
    });
    const end = !next ? fu.on_finish : null;
    const finish = end
      ? [end.move ? "moveria a oportunidade (fim da régua)" : null, end.notify ? "avisaria a equipe" : null, end.turn_off_ai ? "desligaria a IA na conversa" : null].filter(Boolean)
      : [];
    const msg = `${item.label}${texts.length ? "" : ": a IA decidiu não retomar agora (pulada)"}${finish.length ? `. Fim da régua sem resposta: ${finish.join(", ")} (simulação)` : ""}.`;
    await note(conv.id, `Avançar o tempo: ${msg}`);
    return {
      item,
      note: msg,
      result: { turnId: t!.id, status: texts.length ? "done" : "silent", messages: texts.map((x) => ({ text: x, media: [] })), attachments: {} },
      turn: (await sql`select * from public.turns where id = ${t!.id}`)[0] ?? null,
    };
  }

  if (item.kind === "callback") {
    const [cb] = await sql<CallbackRow[]>`
      update public.agent_callbacks set status = 'done', sent_at = now(), outcome = 'teste: avançar o tempo', updated_at = now()
      where id = ${item.id} and status = 'scheduled' returning *`;
    if (!cb) return { item, note: "O retorno já não estava marcado.", result: null, turn: null };
    const cfg = spec.callbacks!;
    const acts = describeActions(cfg.on_due);
    const r = await runTurn({
      conversationId: conv.id,
      spec,
      agentVersion: version,
      event: {
        text:
          `Retorno combinado para ${spLabel(cb.due_at)}: ` +
          (cb.agreed === "confirmed" ? "o lead pediu para ser chamado agora." : "você sugeriu retomar agora e o lead não respondeu à sugestão.") +
          (cb.request ? ` O lead: ${cb.request}.` : "") +
          (cb.topic ? ` Retomar: ${cb.topic}.` : "") +
          " Escreva uma retomada curta e natural, lembrando de leve o combinado, e puxe o assunto de onde parou." +
          (cfg.guide ? ` Orientação: ${cfg.guide}` : ""),
        note: `Avançar o tempo: retorno combinado de ${spLabel(cb.due_at)}${acts.length ? `; na hora: ${acts.join(", ")} (simulação)` : ""}`,
        query: cb.topic || cb.request,
      },
    });
    return { item, note: `${item.label}${acts.length ? `: ${acts.join(", ")} (simulação)` : ""}.`, result: r, turn: r.turnId ? ((await sql`select * from public.turns where id = ${r.turnId}`)[0] ?? null) : null };
  }

  // Sem resposta da equipe a tempo.
  const [q] = await sql<TeamQuestionRow[]>`select * from public.team_questions where id = ${item.id} and status = 'open'`;
  if (!q || !teamOn(spec)) return { item, note: "A dúvida já não estava em aberto.", result: null, turn: null };
  const t = spec.team_questions.timeout;
  if (t.action === "remind") {
    await sql`update public.team_questions set reminders = reminders + 1, updated_at = now() where id = ${q.id}`;
    const msg = `a equipe seria lembrada da dúvida #${q.code} (${q.reminders + 1}º lembrete); o agente segue esperando a resposta`;
    await note(conv.id, `Avançar o tempo: ${msg} (simulação).`);
    return { item, note: msg, result: null, turn: null };
  }
  await sql`update public.team_questions set status = 'expired', due_at = null, outcome = 'teste: sem resposta a tempo', updated_at = now() where id = ${q.id}`;
  if (t.action === "handoff") {
    const msg = `sem resposta da equipe a tempo (#${q.code}): a conversa passaria para uma pessoa e a IA seria desligada`;
    await note(conv.id, `Avançar o tempo: ${msg} (simulação).`);
    return { item, note: msg, result: null, turn: null };
  }
  const r = await runTurn({
    conversationId: conv.id,
    spec,
    agentVersion: version,
    event: { text: teamEventText(q, "give_up", t.give_up_guide), note: `Avançar o tempo: sem resposta da equipe a tempo (#${q.code})`, query: q.question },
  });
  await sql`update public.team_questions set delivered_at = now(), delivered_turn_id = ${r.turnId} where id = ${q.id}`;
  return { item, note: `Sem resposta da equipe (#${q.code}): o agente avisou o lead.`, result: r, turn: r.turnId ? ((await sql`select * from public.turns where id = ${r.turnId}`)[0] ?? null) : null };
}
