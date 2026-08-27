import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

function productionMigrationUrl() {
  const value =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL_UNPOOLED?.trim() ||
    process.env.POSTGRES_URL_NON_POOLING?.trim();

  if (!value) {
    throw new Error(
      "Production deployment requires MIGRATION_DATABASE_URL, DATABASE_URL_UNPOOLED, or POSTGRES_URL_NON_POOLING",
    );
  }
  return value;
}

async function migrateProductionDatabase() {
  console.info("Applying production database migrations...");
  const client = postgres(productionMigrationUrl(), { max: 1, prepare: false });

  try {
    await migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), "drizzle") });

    const [{ current_user: currentUser }] = await client`SELECT current_user`;
    if (!rolePattern.test(currentUser)) {
      throw new Error("Database returned an invalid current role name");
    }
    await client`GRANT app_role TO ${client(currentUser)}`;
    console.info("Production database migrations are current.");
  } finally {
    await client.end({ timeout: 5 });
  }
}

function runNextBuild() {
  const nextBin = resolve(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "build"], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  return new Promise((resolveBuild, rejectBuild) => {
    child.once("error", rejectBuild);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveBuild();
      } else {
        rejectBuild(new Error(`Next.js build failed (${signal ?? `exit ${code}`})`));
      }
    });
  });
}

if (process.env.VERCEL_ENV === "production") {
  await migrateProductionDatabase();
}

await runNextBuild();
