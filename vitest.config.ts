import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/modules/**/*.spec.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./src/test-setup.ts"],
    // Every file shares one real ephemeral cluster. Sequential files avoid
    // unrelated connection bursts while individual tests still create true
    // cross-connection contention intentionally.
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
