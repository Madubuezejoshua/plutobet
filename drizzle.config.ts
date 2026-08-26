import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DIRECT_DATABASE_URL;

if (!url) {
  throw new Error("MIGRATION_DATABASE_URL or DIRECT_DATABASE_URL is required");
}

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/modules/users/schema.ts",
    "./src/modules/audit/schema.ts",
    "./src/modules/wallet/schema.ts",
    "./src/modules/odds/schema.ts",
    "./src/modules/betting/schema.ts",
    "./src/modules/settlement/schema.ts",
    "./src/modules/payments/schema.ts",
    "./src/modules/responsible/schema.ts",
    "./src/modules/casino/schema.ts",
    "./src/modules/notifications/schema.ts",
  ],
  out: "./drizzle",
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
