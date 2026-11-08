import { describe, expect, it } from "vitest";
import { checkGuards, deleteVectors, INDEX_NAME, listVectorIds } from "../scripts/reset-staging";

const ok = { RESET_TARGET: "staging", RESET_CONFIRM: "RESET", CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };

describe("Reset staging guards", () => {
  it("runs only for staging with RESET typed", () => {
    expect(checkGuards(ok)).toBeNull();
    expect(checkGuards({ ...ok, RESET_TARGET: "production" })).toMatch(/staging/);
    expect(checkGuards({ ...ok, RESET_TARGET: undefined })).toMatch(/staging/);
    expect(checkGuards({ ...ok, RESET_CONFIRM: "reset" })).toMatch(/RESET/);
    expect(checkGuards({ ...ok, CLOUDFLARE_API_TOKEN: "" })).toMatch(/Missing/);
  });

  it("targets the staging index, never production's", () => {
    expect(INDEX_NAME).toBe("david-brain-notes");
  });
});

describe("Reset staging vectors", () => {
  it("lists every id across pages", async () => {
    const pages = [
      { vectors: [{ id: "door:1" }, { id: "door:2" }], isTruncated: true, nextCursor: "c1" },
      { vectors: [{ id: "note:3#0" }], isTruncated: false, nextCursor: null },
    ];
    const seen: string[] = [];
    const f = (async (url: URL) => {
      seen.push(String(url));
      return Response.json({ success: true, result: pages.shift() });
    }) as unknown as typeof fetch;
    expect(await listVectorIds("acct", "tok", f)).toEqual(["door:1", "door:2", "note:3#0"]);
    expect(seen[0]).toContain(`/accounts/acct/vectorize/v2/indexes/${INDEX_NAME}/list`);
    expect(seen[1]).toContain("cursor=c1");
  });

  it("deletes in batches and stops on an API error", async () => {
    const bodies: string[][] = [];
    const f = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)).ids);
      return Response.json({ success: true });
    }) as unknown as typeof fetch;
    const ids = Array.from({ length: 5 }, (_, i) => `door:${i}`);
    expect(await deleteVectors("acct", "tok", ids, f, 2)).toBe(5);
    expect(bodies.map((b) => b.length)).toEqual([2, 2, 1]);

    const failing = (async () => Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 403 })) as unknown as typeof fetch;
    await expect(deleteVectors("acct", "tok", ids, failing)).rejects.toThrow(/403/);
  });
});
