export interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  AI: Ai;
  /** Fallback key when DOPPLER_TOKEN isn't set (tests, local dev). */
  BRAIN_KEY?: string;
  /** Read-only Doppler service token; when set, the key is read from Doppler at runtime. */
  DOPPLER_TOKEN?: string;
}
