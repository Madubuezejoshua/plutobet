import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    ".node_modules-incomplete-*/**",
    ".pgdata-*/**",
    "dist/**",
    "coverage/**",
    "drizzle/meta/**",
  ]),
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/modules/wallet/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/modules/wallet/db-direct", "@/modules/wallet/schema"],
              message: "The direct money client and ledger schema are wallet-private. Use the wallet service interface.",
            },
            {
              group: ["**/modules/wallet/db-direct", "**/modules/wallet/schema"],
              message: "The direct money client and ledger schema are wallet-private. Use the wallet service interface.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/modules/wallet/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/pooled", "**/db/pooled"],
              message: "Money paths must use dbDirect; PgBouncer transaction pooling breaks cross-statement FOR UPDATE locks.",
            },
          ],
        },
      ],
    },
  },
  {
    // Acceptance tests intentionally construct production-shaped databases
    // and inspect ledger evidence. Keep the wallet boundary strict for all
    // shipped code while permitting those test-only fixtures.
    files: ["src/**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]);
