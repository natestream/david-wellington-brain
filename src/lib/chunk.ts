/**
 * Split a note into chunks for embedding.
 *
 * bge-base-en-v1.5 reads at most 512 tokens (roughly 2,000 characters of English);
 * anything past that is ignored. So long notes are split on paragraph breaks into
 * chunks of about CHUNK_CHARS, and each chunk gets its own vector.
 *
 * The split is deterministic: the server recomputes it to show the matching
 * excerpt, so nothing extra has to be stored.
 */
export const CHUNK_CHARS = 1500;

export function chunkText(text: string, size: number = CHUNK_CHARS): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of clean.split(/\n{2,}/)) {
    if (para.length > size) {
      // A single huge paragraph: hard-split it.
      push();
      for (let i = 0; i < para.length; i += size) chunks.push(para.slice(i, i + size).trim());
      continue;
    }
    if (current.length + para.length + 2 > size) push();
    current += (current ? "\n\n" : "") + para;
  }
  push();
  return chunks.filter(Boolean);
}
