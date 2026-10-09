/**
 * Horário de Brasília (sem horário de verão desde 2019: -03:00 fixo). As
 * contas de agenda são feitas em "data local + hora local".
 */
export const SP_OFFSET = "-03:00";
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];
const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

export const spDate = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00${SP_OFFSET}`);

export function spYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export const spDayKey = (ymd: string): DayKey => DAY_KEYS[new Date(`${ymd}T12:00:00${SP_OFFSET}`).getUTCDay()]!;
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00${SP_OFFSET}`);
  d.setUTCDate(d.getUTCDate() + n);
  return spYmd(d);
}
/** Minutos desde a meia-noite em Brasília. */
export const spMinutes = (d: Date) => {
  const local = new Date(d.getTime() - 3 * 3600_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
};
export const hmToMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** "quarta-feira, 15/10 às 10:00" */
export function spLabel(d: Date): string {
  const ymd = spYmd(d);
  const local = new Date(d.getTime() - 3 * 3600_000);
  const hm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  return `${WEEKDAYS[new Date(`${ymd}T12:00:00${SP_OFFSET}`).getUTCDay()]}, ${ymd.slice(8, 10)}/${ymd.slice(5, 7)} às ${hm}`;
}
