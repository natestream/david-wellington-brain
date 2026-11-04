import type { Env } from "../env";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMS = 768;

/** Workers AI accepts up to 100 texts per call. */
const MAX_BATCH = 100;

/**
 * Embed one or more texts with Workers AI. This is the only AI call the server makes.
 * Texts are sent in one request (or a few, past 100), so a write costs one call.
 */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = (await env.AI.run(EMBEDDING_MODEL, { text: batch })) as { data?: number[][] };
    if (!res?.data || res.data.length !== batch.length) {
      throw new Error("Embedding failed: Workers AI returned no vectors");
    }
    out.push(...res.data);
  }
  return out;
}

export async function embedOne(env: Env, text: string): Promise<number[]> {
  const [vector] = await embed(env, [text]);
  return vector!;
}
