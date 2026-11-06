/**
 * Minimal client for the Rotor OpenAPI (https://docs.api.getrotor.com/), read-only.
 *
 * Auth: `x-api-key: rotor_{keyId}_{keySecret}` + `rotor-api-version: 1.1.0`.
 * Limit: 1,000 requests per UTC day per key. A day's sync uses about 3-4.
 * Scopes needed: pins:read, timesheets:read, service_plans:read.
 */
export const ROTOR_BASE_URL = "https://api.getrotor.com/open-api";
export const ROTOR_API_VERSION = "1.1.0";
/** Largest page the API allows. */
const PAGE_LIMIT = 1000;
/** Safety cap so a bad loop can never burn the daily quota. */
const MAX_PAGES = 10;

export interface RotorUser {
  user_id: string;
  email: string;
  name: string;
}

export interface RotorPin {
  id: string;
  created_at: string;
  created_by: RotorUser;
  pin_type: { id: string; label: string; color: string } | null;
  location: [number, number];
}

export interface RotorTimesheet {
  id: string;
  created_at: string;
  user: RotorUser;
  category: "service" | "sales" | "office" | string;
  start: string;
  end: string | null;
  duration_minutes: number | null;
}

export interface RotorServicePlan {
  id: string;
  created_at: string;
  sold_by: RotorUser | null;
  sale_value: number | null;
  service_types?: string[];
  service_frequency: string | null;
  start_date: string | null;
  active: boolean;
  cancelled: boolean;
  is_signed: boolean;
  num_scheduled_jobs: number | null;
  num_pending_jobs: number | null;
  customer: { id: string; first_name: string | null; last_name: string | null; company_name: string | null } | null;
}

interface Page<T> {
  status: string;
  data: T[];
  pagination?: { page: number; limit: number; total: number; has_more: boolean };
}

export class RotorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class RotorClient {
  requests = 0;

  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<Page<T>> {
    const url = new URL(ROTOR_BASE_URL + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    this.requests++;
    const res = await this.fetchImpl(url.toString(), {
      headers: { "x-api-key": this.apiKey, "rotor-api-version": ROTOR_API_VERSION, accept: "application/json" },
    });
    if (!res.ok) {
      let body: { message?: string; error_code?: string; reset_at?: string } = {};
      try {
        body = await res.json();
      } catch {
        /* not JSON */
      }
      const hint =
        res.status === 401
          ? " Check the ROTOR_API_KEY secret."
          : res.status === 403
            ? " The key needs the pins:read, timesheets:read and service_plans:read scopes."
            : res.status === 429
              ? ` Daily limit reached; resets ${body.reset_at ?? "at 00:00 UTC"}.`
              : "";
      throw new RotorError(`Rotor API ${res.status} on ${path}: ${body.message ?? res.statusText}.${hint}`, res.status, body.error_code);
    }
    return (await res.json()) as Page<T>;
  }

  /**
   * Pins created in [start, end). The endpoint has no date filter and returns
   * newest first, so page back until a page reaches past `start`.
   */
  async pinsBetween(start: Date, end: Date): Promise<RotorPin[]> {
    const out: RotorPin[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.get<RotorPin>("/pins", { page, limit: PAGE_LIMIT });
      const pins = res.data ?? [];
      for (const p of pins) {
        const t = Date.parse(p.created_at);
        if (t >= start.getTime() && t < end.getTime()) out.push(p);
      }
      const oldest = pins.at(-1);
      if (!res.pagination?.has_more || !oldest || Date.parse(oldest.created_at) < start.getTime()) return out;
    }
    throw new RotorError(`Stopped after ${MAX_PAGES} pages of pins without reaching ${start.toISOString()}.`, 0);
  }

  /** Timesheets that started in [start, end]. */
  async timesheetsBetween(start: Date, end: Date): Promise<RotorTimesheet[]> {
    return this.paged<RotorTimesheet>("/timesheets", { start_date: start.toISOString(), end_date: end.toISOString() });
  }

  /** Service plans created in [start, end]. */
  async servicePlansCreatedBetween(start: Date, end: Date): Promise<RotorServicePlan[]> {
    return this.paged<RotorServicePlan>("/service-plans", {
      created_at_range_start: start.toISOString(),
      created_at_range_end: end.toISOString(),
    });
  }

  private async paged<T>(path: string, query: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.get<T>(path, { ...query, page, limit: PAGE_LIMIT });
      out.push(...(res.data ?? []));
      if (!res.pagination?.has_more) return out;
    }
    throw new RotorError(`Stopped after ${MAX_PAGES} pages of ${path}.`, 0);
  }
}
