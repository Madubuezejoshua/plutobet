import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, pooledSql } from "../src/db/pooled";
import { normalizeEmail } from "../src/modules/auth/email";
import { hashPassword } from "../src/modules/auth/password";
import { users } from "../src/modules/users/schema";

function requiredSeedValue(name: "SEED_ADMIN_EMAIL" | "SEED_ADMIN_PASSWORD"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required; the admin seed has no default credentials`);
  }
  return value;
}

async function seedAdmin(): Promise<void> {
  const rawEmail = requiredSeedValue("SEED_ADMIN_EMAIL");
  const password = requiredSeedValue("SEED_ADMIN_PASSWORD");
  const email = z.string().trim().email().max(320).parse(normalizeEmail(rawEmail));
  const passwordHash = await hashPassword(password);

  const result = await db.transaction(async (tx) => {
    // Serialize seed attempts across deploy instances. The key is stable and
    // transaction-scoped, so a crashed seed cannot leave a permanent lock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('seed:initial-admin', 0))`);

    const [existing] = await tx
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing) {
      if (existing.role !== "ADMIN") {
        throw new Error(
          `refusing to promote existing non-admin account ${email}; use an audited admin workflow`,
        );
      }
      if (existing.status !== "ACTIVE") {
        throw new Error(
          `admin ${email} already exists with status ${existing.status}; refusing to reactivate it from a seed`,
        );
      }
      return { created: false as const, id: existing.id };
    }

    const [otherAdmin] = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.role, "ADMIN"))
      .limit(1);
    if (otherAdmin) {
      throw new Error(
        `initial admin already exists as ${otherAdmin.email} (${otherAdmin.id}); refusing to seed another`,
      );
    }

    const [inserted] = await tx
      .insert(users)
      .values({
        email,
        passwordHash,
        role: "ADMIN",
        status: "ACTIVE",
        mustChangePassword: true,
        kycLevel: 0,
      })
      // A user registration can still race this seed without taking its
      // advisory lock. Never overwrite or promote that row on conflict.
      .onConflictDoNothing()
      .returning({ id: users.id });

    if (!inserted) {
      throw new Error(
        `account ${email} appeared while seeding; refusing to overwrite or promote it`,
      );
    }
    return { created: true as const, id: inserted.id };
  });

  if (result.created) {
    console.info(`Seeded initial admin ${email} (${result.id}); password change is required`);
  } else {
    console.info(`Admin ${email} already exists (${result.id}); no credentials or state changed`);
  }
}

seedAdmin()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "admin seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pooledSql.end({ timeout: 5 });
  });
