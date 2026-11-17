import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

function migrationUrl(): string {
  const ownerUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL_UNPOOLED?.trim() ||
    process.env.POSTGRES_URL_NON_POOLING?.trim();
  if (process.env.NODE_ENV === "production" && !ownerUrl) {
    throw new Error(
      "MIGRATION_DATABASE_URL or a Vercel unpooled database URL is required in production; runtime roles must not own ledger tables",
    );
  }
  const value = ownerUrl || process.env.DIRECT_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "MIGRATION_DATABASE_URL, DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING, or DIRECT_DATABASE_URL is required",
    );
  }
  return value;
}

async function main(): Promise<void> {
  const client = postgres(migrationUrl(), { max: 1, prepare: false });
  const migrationDb = drizzle(client);

  try {
    await migrate(migrationDb, { migrationsFolder: "drizzle" });
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("Database migration failed", error);
  process.exitCode = 1;
});
