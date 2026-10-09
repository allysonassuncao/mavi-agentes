import { z } from "zod";

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário no formato HH:MM");
const Day = z
  .object({ from: Time, to: Time })
  .strict()
  .refine((d) => d.from < d.to, "O horário de início deve ser antes do fim.")
  .nullable();
/** Horário da semana (null = fechado; ausente = não informado). */
export const WeeklyHours = z
  .object({ mon: Day.optional(), tue: Day.optional(), wed: Day.optional(), thu: Day.optional(), fri: Day.optional(), sat: Day.optional(), sun: Day.optional() })
  .strict();
export type WeeklyHours = z.infer<typeof WeeklyHours>;
