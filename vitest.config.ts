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
    // Modules hold the money logic; lib and components hold the pure helpers
    // the interface is built from. Both are plain TypeScript, so both run in
    // the same node environment against the same ephemeral cluster.
    include: [
      "src/modules/**/*.spec.ts",
      "src/lib/**/*.spec.ts",
      "src/components/**/*.spec.ts",
    ],
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
