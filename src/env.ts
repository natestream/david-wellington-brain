export interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  AI: Ai;
  BRAIN_KEY: string;
  /** Optional (v2). Rotor API key with pins:read, timesheets:read, service_plans:read. Enables the Rotor sync. */
  ROTOR_API_KEY?: string;
  /** Optional (v2). David's Rotor login email: picks his pins, timesheets and plans out of the company's data. */
  ROTOR_REP_EMAIL?: string;
}
