import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The OWNER connection used to migrate.
 *
 * Deliberately never falls back to DATABASE_URL. The runtime role must not own
 * the ledger tables — that separation is what stops application code from
 * altering a table a trigger depends on — so migrating as the app role would
 * quietly dismantle the guarantee this whole design rests on.
 *
 * Returns null rather than throwing: a missing owner URL should not turn a
 * deployment into a failed build, because the database may already be current.
 * The caller warns instead, and /api/health reports the applied count.
 */
function productionMigrationUrl() {
  return (
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL_UNPOOLED?.trim() ||
    process.env.POSTGRES_URL_NON_POOLING?.trim() ||
    null
  );
}

async function migrateProductionDatabase() {
  const url = productionMigrationUrl();
  if (!url) {
    console.warn(
      "deploy: no owner database URL (MIGRATION_DATABASE_URL / DATABASE_URL_UNPOOLED /\n" +
        "        POSTGRES_URL_NON_POOLING) — SKIPPING MIGRATIONS.\n" +
        "        If the schema is not already current this deployment will fail at runtime.\n" +
        "        Check /api/health after deploying; it reports the applied migration count.",
    );
    return;
  }

  console.info("Applying production database migrations...");
  const client = postgres(url, { max: 1, prepare: false });

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

/**
 * Which host are we building on, and is this a real deployment?
 *
 * This was previously `VERCEL_ENV === "production"` and nothing else, which
 * meant that on Railway — where VERCEL_ENV is never set — migrations and the
 * app_role grant silently did not run. Nothing failed loudly; the build
 * succeeded and the deployment came up against whatever state the database
 * happened to be in.
 *
 * Any new host must be added here. The failure mode of forgetting is silence,
 * so `deploy:` in the log below is deliberately printed on every build.
 */
function deploymentTarget() {
  if (process.env.VERCEL_ENV === "production") return "vercel";
  // Railway sets several; RAILWAY_ENVIRONMENT_NAME is the stable one, and the
  // others are checked because Railway has renamed these before.
  if (
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID
  ) {
    return "railway";
  }
  return null;
}

const target = deploymentTarget();
console.info(`deploy: target=${target ?? "local (no migrations)"}`);

if (target) {
  await migrateProductionDatabase();
}

await runNextBuild();
