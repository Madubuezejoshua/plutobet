import "dotenv/config";
import postgres from "postgres";

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;

async function main(): Promise<void> {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const runtimeRole = process.env.APP_DATABASE_ROLE;
  if (!ownerUrl) throw new Error("MIGRATION_DATABASE_URL is required");
  if (!runtimeRole || !rolePattern.test(runtimeRole)) {
    throw new Error("APP_DATABASE_ROLE must be a valid unquoted PostgreSQL role name");
  }

  const owner = postgres(ownerUrl, { max: 1, prepare: false });
  try {
    await owner`GRANT app_role TO ${owner(runtimeRole)}`;
    console.info(`Granted app_role membership to ${runtimeRole}`);
  } finally {
    await owner.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "role grant failed");
  process.exitCode = 1;
});
