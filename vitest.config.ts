import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The OAuth library imports `cloudflare:workers`, which only exists in workerd.
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/stubs/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Bundle it through Vite so the alias above applies (Node would load it, and fail on cloudflare:).
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
