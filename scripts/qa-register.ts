/**
 * Phase 4: register a QA account through the REAL registration service.
 *
 *   npx tsx scripts/qa-register.ts
 *
 * Uses registrationService, the same path the public API calls — no direct
 * INSERT into users, because inserting the row would skip every check the
 * thing being validated exists to perform.
 *
 * Prints the new user id and email. The password is generated here and shown
 * ONCE so the account can be signed into; it belongs to a throwaway
 * `@plutobet.test` address holding no real money and no real identity.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { registrationService } from "@/modules/users/registration.service";

async function main() {
  const stamp = Date.now();
  const email = `qa-flow-${stamp}@plutobet.test`;
  const password = `${randomBytes(12).toString("base64url")}!aA9`;
  // 0803 is a real NG mobile prefix; the remainder is timestamp-derived so
  // repeated runs never collide on the unique phone index.
  const phoneNumber = `0803${String(stamp).slice(-7)}`;

  const user = await registrationService.register({
    email,
    password,
    phoneNumber,
    dateOfBirth: "1995-06-15",
    firstName: "QA",
    lastName: "Flow",
  });

  const wallets = await db.execute<{ bucket: string; balance: string; id: string }>(sql`
    SELECT bucket::text, cached_balance_minor::text AS balance, id::text
    FROM wallets WHERE user_id = ${user.userId}::uuid ORDER BY bucket
  `);

  const [row] = await db.execute<{
    status: string;
    kyc_level: number;
    email_verified_at: Date | null;
    phone_verified_at: Date | null;
    created_at: Date;
    hash_prefix: string;
  }>(sql`
    SELECT status::text, kyc_level, email_verified_at, phone_verified_at, created_at,
           left(password_hash, 9) AS hash_prefix
    FROM users WHERE id = ${user.userId}::uuid
  `);

  console.log(`userId       : ${user.userId}`);
  console.log(`email        : ${email}`);
  console.log(`password     : ${password}`);
  console.log(`referralCode : ${user.referralCode}`);
  console.log(`status       : ${row?.status}  kycLevel: ${row?.kyc_level}`);
  console.log(`emailVerified: ${row?.email_verified_at !== null}`);
  console.log(`phoneVerified: ${row?.phone_verified_at !== null}`);
  console.log(`createdAt    : ${new Date(row!.created_at).toISOString()}`);
  // Proves the algorithm without revealing the digest.
  console.log(`passwordHash : ${row?.hash_prefix}… (argon2id)`);
  console.log(`wallets      : ${wallets.map((w) => `${w.bucket}=${w.balance}`).join(" ")}`);

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("qa-register failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
