import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  AI: Ai;
  /** OAuth clients, grants and tokens for Google sign-in (stored hashed/encrypted by the library). */
  OAUTH_KV: KVNamespace;
  /** Set by the OAuth library on requests it hands to the sign-in routes. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Read-only Doppler service token; when set, every secret below comes from Doppler at runtime. */
  DOPPLER_TOKEN?: string;
  /** Env fallbacks when DOPPLER_TOKEN isn't set (tests, local dev). */
  BRAIN_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ALLOWED_EMAILS?: string;
}
