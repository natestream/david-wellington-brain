import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { CACHE_MS, DOPPLER_URL, getBrainKey, resetKeyCache } from "../src/lib/keystore";
import { makeCtx, makeEnv } from "./fakes";

/** A fake Doppler: answers the secrets download with whatever `key` is now, or fails when `down`. */
function fakeDoppler(initial: string) {
  const state = { key: initial as string | undefined, down: false, status: 200, calls: 0, lastAuth: "" };
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    state.calls++;
    expect(String(url)).toBe(DOPPLER_URL);
    state.lastAuth = new Headers(init?.headers).get("authorization") ?? "";
    if (state.down) throw new Error("network down");
    if (state.status !== 200) return new Response("nope", { status: state.status });
    return Response.json(state.key === undefined ? {} : { BRAIN_KEY: state.key, OTHER: "x" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

const dopplerEnv = () => ({ ...makeEnv("env-key-ignored"), DOPPLER_TOKEN: "dp.st.staging.test" });

const listReq = (key: string) =>
  new Request("https://brain.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

beforeEach(() => resetKeyCache());
afterEach(() => vi.unstubAllGlobals());

describe("key from Doppler (#21)", () => {
  it("reads BRAIN_KEY from Doppler with the service token, and ignores BRAIN_KEY in the env", async () => {
    const doppler = fakeDoppler("doppler-key");
    const env = dopplerEnv();
    expect((await worker.fetch(listReq("doppler-key"), env, makeCtx())).status).toBe(200);
    expect((await worker.fetch(listReq("env-key-ignored"), env, makeCtx())).status).toBe(401);
    expect(doppler.lastAuth).toBe("Bearer dp.st.staging.test");
  });

  it("caches the key, so Doppler isn't called on every request", async () => {
    const doppler = fakeDoppler("k1");
    const env = dopplerEnv();
    const t = 1_000_000;
    await getBrainKey(env, t);
    await getBrainKey(env, t + 1_000);
    await getBrainKey(env, t + CACHE_MS - 1);
    expect(doppler.calls).toBe(1);
  });

  it("picks up a key changed in Doppler once the cache expires, with no redeploy", async () => {
    const doppler = fakeDoppler("old-key");
    const env = dopplerEnv();
    const t = 1_000_000;
    expect(await getBrainKey(env, t)).toEqual({ ok: true, key: "old-key" });
    doppler.key = "new-key";
    expect(await getBrainKey(env, t + 1_000)).toEqual({ ok: true, key: "old-key" }); // still cached
    expect(await getBrainKey(env, t + CACHE_MS + 1)).toEqual({ ok: true, key: "new-key" });
  });

  it("keeps working on the last good key when Doppler goes down", async () => {
    const doppler = fakeDoppler("good-key");
    const env = dopplerEnv();
    const t = 1_000_000;
    await getBrainKey(env, t);
    doppler.down = true;
    expect(await getBrainKey(env, t + CACHE_MS + 1)).toEqual({ ok: true, key: "good-key" });
    doppler.down = false;
    doppler.status = 500;
    expect(await getBrainKey(env, t + 2 * CACHE_MS + 2)).toEqual({ ok: true, key: "good-key" });
  });

  it("refuses with 503 (never lets a request in) when Doppler is down and there's no cached key", async () => {
    const doppler = fakeDoppler("k");
    doppler.down = true;
    const res = await worker.fetch(listReq("anything"), dopplerEnv(), makeCtx());
    expect(res.status).toBe(503);
  });

  it("refuses when the Doppler config has no BRAIN_KEY, or the token is rejected", async () => {
    const doppler = fakeDoppler("k");
    doppler.key = undefined;
    expect((await getBrainKey(dopplerEnv())).ok).toBe(false);
    resetKeyCache();
    doppler.key = "k";
    doppler.status = 401;
    expect(await getBrainKey(dopplerEnv())).toMatchObject({ ok: false, status: 503 });
  });

  it("shares one Doppler call between requests that arrive together", async () => {
    const doppler = fakeDoppler("k");
    const env = dopplerEnv();
    const results = await Promise.all([getBrainKey(env), getBrainKey(env), getBrainKey(env)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(doppler.calls).toBe(1);
  });

  it("falls back to BRAIN_KEY in the env when there's no DOPPLER_TOKEN, without calling Doppler", async () => {
    const doppler = fakeDoppler("unused");
    expect(await getBrainKey(makeEnv("local-key"))).toEqual({ ok: true, key: "local-key" });
    expect(doppler.calls).toBe(0);
  });
});
