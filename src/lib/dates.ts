export const TIME_ZONE = "America/Los_Angeles";

const ymd = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date as YYYY-MM-DD in America/Los_Angeles. */
export function today(now: Date = new Date()): string {
  return ymd.format(now);
}

/** Shift a YYYY-MM-DD date by whole days (calendar math, no time zone involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Minutes to add to Los Angeles wall-clock time to get UTC at this instant (480 in PST, 420 in PDT). */
function laOffsetMinutes(instant: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((instant - asUtc) / 60000);
}

/** Start of a Los Angeles calendar day as a UTC instant (ms). DST-safe. */
function laMidnightUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall + laOffsetMinutes(wall + 8 * 3600_000) * 60000;
  guess = wall + laOffsetMinutes(guess) * 60000;
  return guess;
}

/** The UTC range [start, end) covering one Los Angeles calendar day. */
export function laDayRangeUtc(date: string): { start: Date; end: Date } {
  return { start: new Date(laMidnightUtc(date)), end: new Date(laMidnightUtc(addDays(date, 1))) };
}

export function nowIso(): string {
  return new Date().toISOString();
}
