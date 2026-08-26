for (const name of [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "REDIS_URL",
] as const) {
  if (!process.env[name]) {
    throw new Error(`${name} must be provided by vitest.global-setup.ts`);
  }
}

