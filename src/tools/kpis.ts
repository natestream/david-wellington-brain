import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { DATE_RE, isValidDate, nowIso, today } from "../lib/dates";
import { guard, ok, rate } from "../lib/result";

/**
 * Daily KPI inputs, exactly as in "Wellington Sales KPI Calculations" (David's guide).
 *
 * From the Rotor pin export ("New Pins by Team Member"): one count per pin type.
 * Entered by the rep: hours knocked and ARR sold.
 *
 * Only these inputs are stored. Subtotals and KPIs are calculated when read
 * (computeKpis), so a date range adds up the inputs first and then divides,
 * which is the correct way to get a week's rate.
 */
export const KPI_FIELDS = {
  total: { kind: "int", export: "Total", describe: "Total pins (Rotor 'Total')." },
  gave_pitch: { kind: "int", export: "Gave Pitch", describe: "Rotor 'Gave Pitch' pins." },
  go_back: { kind: "int", export: "Go Back", describe: "Rotor 'Go Back' pins." },
  never_knock: { kind: "int", export: "Never Knock", describe: "Rotor 'Never Knock' pins." },
  door_hanger: { kind: "int", export: "Door Hanger", describe: "Rotor 'Door Hanger' pins." },
  no_answer: { kind: "int", export: "No Answer", describe: "Rotor 'No Answer' pins." },
  not_interested: { kind: "int", export: "Not Interested", describe: "Rotor 'Not Interested' pins." },
  made_sale: { kind: "int", export: "Made Sale", describe: "Rotor 'Made Sale' pins." },
  hours_knocked: { kind: "num", export: null, describe: "Hours knocked that day (entered by the rep, not on the export)." },
  arr_sold: {
    kind: "num",
    export: null,
    describe: "ARR sold that day in dollars: one year of revenue per plan, even when the agreement runs longer (entered by the rep).",
  },
} as const;

export type KpiField = keyof typeof KPI_FIELDS;
export const KPI_FIELD_NAMES = Object.keys(KPI_FIELDS) as KpiField[];
/** Pin types that make up Total, in Rotor's export order. */
export const PIN_FIELDS = ["gave_pitch", "go_back", "never_knock", "door_hanger", "no_answer", "not_interested", "made_sale"] as const;
export const KPI_SOURCES = ["pdf", "crm", "manual"] as const;

export type KpiValues = Partial<Record<KpiField, number | null>>;

export interface KpiRow extends Record<KpiField, number | null> {
  id: string;
  date: string;
  rep: string;
  source: (typeof KPI_SOURCES)[number];
  raw_summary: string | null;
  extra: string | null;
  updated_at: string;
}

/**
 * Step 1 (subtotals) and Step 2 (KPIs) from David's guide.
 * A missing pin type counts as 0; a KPI is null when its denominator is 0 or missing.
 */
export function computeKpis(k: KpiValues) {
  const n = (v: number | null | undefined) => v ?? 0;
  const adjusted_doors = k.total == null ? null : k.total - n(k.go_back) - n(k.never_knock) - n(k.door_hanger);
  const answered = adjusted_doors == null ? null : adjusted_doors - n(k.no_answer);
  const pitches = k.gave_pitch == null && k.made_sale == null ? null : n(k.gave_pitch) + n(k.made_sale);
  const plans_sold = k.made_sale ?? null;

  return {
    subtotals: { adjusted_doors, answered, pitches, plans_sold },
    kpis: {
      doors_per_hour: rate(adjusted_doors, k.hours_knocked, 2),
      answer_rate: rate(answered, adjusted_doors),
      backyard_rate: rate(pitches, answered),
      conversion_rate: rate(plans_sold, pitches),
      revenue_per_hour: rate(k.arr_sold, k.hours_knocked, 2),
      avg_arr_per_plan: rate(k.arr_sold, plans_sold, 2),
    },
  };
}

export interface SaveKpisInput extends KpiValues {
  date?: string;
  rep?: string;
  source?: (typeof KPI_SOURCES)[number];
  raw_summary?: string | null;
  extra?: Record<string, string | number | boolean | null> | null;
}

/** Door outcomes (log_door) use the same names as Rotor pin types, so they compare 1:1. */
const LOGGED_OUTCOMES = PIN_FIELDS;

export interface SaveKpisOptions {
  /**
   * Fields that only fill a blank: an existing saved value wins.
   * The Rotor sync uses this for hours_knocked and arr_sold so it never
   * overwrites numbers David entered himself.
   */
  keepExisting?: readonly KpiField[];
}

export async function saveDailyKpis(env: Env, input: SaveKpisInput, opts: SaveKpisOptions = {}) {
  const date = input.date ?? today();
  if (!isValidDate(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  const rep = input.rep?.trim() || "david";
  const values = KPI_FIELD_NAMES.map((f) => input[f] ?? null);
  const extra = input.extra && Object.keys(input.extra).length ? JSON.stringify(input.extra) : null;

  const cols = KPI_FIELD_NAMES.join(", ");
  const qs = KPI_FIELD_NAMES.map(() => "?").join(", ");
  // UNIQUE(rep, date): saving a day again updates that day's row (never a second row).
  // Fields left out keep their saved value, so "I knocked 5 hours, sold $1,800 ARR"
  // can be added after the pin export without re-sending the pin counts.
  const updates = [
    ...[...KPI_FIELD_NAMES, "raw_summary", "extra"].map((c) =>
      opts.keepExisting?.includes(c as KpiField)
        ? `${c} = COALESCE(daily_kpis.${c}, excluded.${c})`
        : `${c} = COALESCE(excluded.${c}, daily_kpis.${c})`,
    ),
    "source = excluded.source",
    "updated_at = excluded.updated_at",
  ].join(", ");

  await env.DB.prepare(
    `INSERT INTO daily_kpis (id, date, rep, ${cols}, source, raw_summary, extra, updated_at)
     VALUES (?, ?, ?, ${qs}, ?, ?, ?, ?)
     ON CONFLICT (rep, date) DO UPDATE SET ${updates}`,
  )
    .bind(crypto.randomUUID(), date, rep, ...values, input.source ?? "pdf", input.raw_summary?.trim() || null, extra, nowIso())
    .run();

  const saved = await env.DB.prepare(`SELECT * FROM daily_kpis WHERE rep = ? AND date = ?`).bind(rep, date).first<KpiRow>();
  if (!saved) throw new Error("KPI row was not saved");

  const outcomeSums = LOGGED_OUTCOMES.map((o) => `SUM(CASE WHEN outcome = '${o}' THEN 1 ELSE 0 END) AS ${o}`).join(", ");
  const logged = await env.DB.prepare(`SELECT COUNT(*) AS total, ${outcomeSums} FROM doors WHERE rep = ? AND date = ?`)
    .bind(rep, date)
    .first<Record<string, number | null>>();
  const loggedCounts: Record<string, number> = { total: logged?.total ?? 0 };
  for (const o of LOGGED_OUTCOMES) loggedCounts[o] = logged?.[o] ?? 0;

  const parts: string[] = [];
  if (saved.total != null) parts.push(`Rotor says ${saved.total} pins, ${loggedCounts.total} doors logged`);
  else parts.push(`${loggedCounts.total} doors logged`);
  if (saved.made_sale != null) parts.push(`${saved.made_sale} sales in Rotor, ${loggedCounts.made_sale} logged`);

  const warnings: string[] = [];
  if (saved.total != null && PIN_FIELDS.every((f) => saved[f] != null)) {
    const sum = PIN_FIELDS.reduce((s, f) => s + (saved[f] ?? 0), 0);
    if (sum !== saved.total) warnings.push(`Pin types add up to ${sum}, but Total is ${saved.total}. Double-check the numbers.`);
  }
  const missing = (["hours_knocked", "arr_sold"] as const).filter((f) => saved[f] == null);
  if (missing.length) {
    warnings.push(
      `Missing ${missing.join(" and ")} (not on the Rotor export). Ask the rep, then call save_daily_kpis again with just those fields.`,
    );
  }

  return {
    saved: { ...saved, extra: saved.extra ? JSON.parse(saved.extra) : null },
    ...computeKpis(saved),
    logged_vs_rotor: {
      summary: parts.join("; "),
      logged: loggedCounts,
      unlogged_doors: saved.total != null ? Math.max(0, saved.total - loggedCounts.total!) : null,
    },
    ...(warnings.length ? { warnings } : {}),
  };
}

export interface GetKpisInput {
  from?: string;
  to?: string;
  rep?: string;
  group_by?: "day" | "week" | "none";
}

export async function getKpis(env: Env, input: GetKpisInput) {
  const to = input.to ?? today();
  const from = input.from ?? to;
  for (const [name, v] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (!isValidDate(v)) throw new Error(`${name} must be YYYY-MM-DD, got "${v}"`);
  }
  if (from > to) throw new Error(`from (${from}) is after to (${to})`);
  const groupBy = input.group_by ?? "day";

  const where = ["date >= ?", "date <= ?"];
  const params: unknown[] = [from, to];
  if (input.rep) {
    where.push("rep = ?");
    params.push(input.rep);
  }

  // Week = Monday-start. SQLite: step back 6 days, then forward to the next Monday.
  const period = groupBy === "week" ? "date(date, '-6 days', 'weekday 1')" : groupBy === "day" ? "date" : "'total'";
  const sums = KPI_FIELD_NAMES.map((f) => `SUM(${f}) AS ${f}`).join(", ");

  const { results } = await env.DB.prepare(
    `SELECT ${period} AS period, COUNT(DISTINCT date) AS days, ${sums}
       FROM daily_kpis
      WHERE ${where.join(" AND ")}
      GROUP BY period
      ORDER BY period`,
  )
    .bind(...params)
    .all<{ period: string; days: number } & KpiValues>();

  const rows = (results ?? []).map((r) => ({ ...r, ...computeKpis(r) }));

  const totals: KpiValues & { days: number } = { days: 0 };
  for (const r of rows) {
    totals.days += r.days;
    for (const f of KPI_FIELD_NAMES) {
      const v = r[f];
      if (v != null) totals[f] = round2((totals[f] ?? 0) + v);
    }
  }

  return {
    from,
    to,
    rep: input.rep ?? "all",
    group_by: groupBy,
    rows: groupBy === "none" ? [] : rows,
    totals: { ...totals, ...computeKpis(totals) },
    note: rows.length === 0 ? "No KPI rows in this range. KPIs come from save_daily_kpis (the Rotor pin export)." : undefined,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const dateField = z.string().regex(DATE_RE, "YYYY-MM-DD");

function kpiShape() {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, def] of Object.entries(KPI_FIELDS)) {
    const base = def.kind === "int" ? z.number().int().nonnegative() : z.number().nonnegative();
    shape[name] = base.nullish().describe(def.describe);
  }
  return shape as Record<KpiField, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
}

const KPI_DEFINITIONS = `Subtotals: adjusted_doors = Total - Go Back - Never Knock - Door Hanger; answered = adjusted_doors - No Answer; pitches = Gave Pitch + Made Sale; plans_sold = Made Sale.
The 6 KPIs: doors_per_hour = adjusted_doors / hours_knocked; answer_rate = answered / adjusted_doors; backyard_rate = pitches / answered; conversion_rate = plans_sold / pitches; revenue_per_hour (annualized) = arr_sold / hours_knocked; avg_arr_per_plan (annualized) = arr_sold / plans_sold.`;

export function registerKpiTools(server: McpServer, env: Env) {
  server.registerTool(
    "save_daily_kpis",
    {
      title: "Save daily KPIs",
      description: `Save one rep's day from the Rotor CRM pin export ("New Pins by Team Member": Team Member, Total, Gave Pitch, Go Back, Never Knock, Door Hanger, No Answer, Not Interested, Made Sale), plus the two numbers the rep enters: hours_knocked and arr_sold. One row per rep per day.

Before calling:
1. Read the export (PDF, CSV, screenshot or pasted text) yourself. For now this brain is David's only: save just David's row (the Team Member whose first name is David) and ignore the other team members, unless he explicitly asks you to save someone else's.
2. Leave rep out (it defaults to "david"). Teammates come in a later version.
3. Copy each pin count exactly. Never guess a number.
4. hours_knocked and arr_sold aren't on the export. Use them if he gave them; otherwise save the pins now and ask him for both. ARR is one year of revenue per plan, even for longer agreements.
5. Write a 1-sentence raw_summary. Other numbers worth keeping go in extra.

Saving the same rep and day again updates that row; fields you leave out keep their saved value, so you can send just hours_knocked and arr_sold later.

After calling: give the 6 KPIs in a short list (rates are fractions; say them as percentages). Mention warnings and a big logged_vs_rotor gap briefly, without nagging.

${KPI_DEFINITIONS}`,
      inputSchema: {
        date: dateField.optional().describe("The day the numbers are for, YYYY-MM-DD. Take it from the export; leave out for today (Los Angeles time)."),
        rep: z.string().optional().describe("Leave out (David). Reserved for teammates in a later version."),
        ...kpiShape(),
        source: z.enum(KPI_SOURCES).optional().describe("pdf (default): from an export/PDF/screenshot. crm: pulled from the Rotor API directly. manual: he typed them."),
        raw_summary: z.string().nullish().describe("Your 1-sentence summary of the day."),
        extra: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .nullish()
          .describe("Any other numbers worth keeping that don't fit the fields above."),
      },
      annotations: { title: "Save daily KPIs", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await saveDailyKpis(env, args as SaveKpisInput))),
  );

  server.registerTool(
    "get_kpis",
    {
      title: "Get KPIs",
      description: `David's 6 KPIs (doors per hour, answer rate, backyard rate, conversion rate, revenue per hour annualized, average ARR per plan annualized) for a day or a date range, with the subtotals behind them. Pure math, no guessing.

Use for "how did I do today/this week/this month?", comparing weeks or reps, or spotting trends. For a range, the inputs are added up first and the KPIs are calculated from the totals (not an average of daily rates). A KPI is null when its denominator is 0 or missing (e.g. no hours_knocked saved). Rates are fractions; say them as percentages. Keep the answer short and lead with what changed.

Today is in Los Angeles time. For "this week" pass from = Monday of this week. Leave rep out; for now everything is David's.

${KPI_DEFINITIONS}`,
      inputSchema: {
        from: dateField.optional().describe("Start YYYY-MM-DD (inclusive). Defaults to the same as to."),
        to: dateField.optional().describe("End YYYY-MM-DD (inclusive). Defaults to today."),
        rep: z.string().optional().describe("Leave out (David). Reserved for teammates in a later version."),
        group_by: z.enum(["day", "week", "none"]).optional().describe("day (default): a row per day. week: a row per Monday-start week. none: totals only."),
      },
      annotations: { title: "Get KPIs", readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await getKpis(env, args))),
  );
}
