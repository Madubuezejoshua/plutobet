import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeBettingContexts,
  createBettingContext,
  createFundedUser,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import {
  hashBvn,
  hashNin,
  identityMatches,
  InvalidIdentityNumberError,
  maskIdentity,
} from "../identity";
import { KycRejectedError, KycService } from "../kyc.service";

const PEPPER = "test-pepper-at-least-32-characters-long!!";
const contexts: BettingContext[] = [];
function context(): BettingContext {
  const created = createBettingContext();
  contexts.push(created);
  return created;
}

beforeAll(() => {
  process.env.IDENTITY_PEPPER = PEPPER;
});

afterAll(async () => {
  await closeBettingContexts(contexts);
});

function bvn(): string {
  return String(10_000_000_000 + Math.floor(Math.random() * 89_999_999_999)).slice(0, 11);
}

describe("identity digests", () => {
  it("is deterministic, so an identity can be looked up", () => {
    // Determinism is required, not incidental: self-exclusion must survive
    // re-registration, which means finding the same person again.
    expect(hashBvn("22222222222")).toBe(hashBvn("22222222222"));
    expect(hashBvn("22222222222")).toHaveLength(64);
  });

  it("never returns anything resembling the input", () => {
    const raw = "22222222222";
    const digest = hashBvn(raw);
    expect(digest).not.toContain(raw);
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(true);
  });

  it("separates the same digits presented as a BVN and as a NIN", () => {
    // Without the kind in the HMAC input these would collide and two
    // different people could be treated as one identity.
    expect(hashBvn("33333333333")).not.toBe(hashNin("33333333333"));
  });

  it("changes completely when the pepper changes", () => {
    const withFirst = hashBvn("44444444444");
    process.env.IDENTITY_PEPPER = "a-completely-different-pepper-32-chars!!";
    const withSecond = hashBvn("44444444444");
    process.env.IDENTITY_PEPPER = PEPPER;

    // This is why the pepper can never be rotated: every stored digest would
    // stop matching, and BVNs cannot be re-collected to re-hash them.
    expect(withFirst).not.toBe(withSecond);
  });

  it("rejects anything that is not 11 digits", () => {
    for (const bad of ["", "123", "1234567890a", "222222222222", " 2222222222"]) {
      expect(() => hashBvn(bad)).toThrow(InvalidIdentityNumberError);
    }
  });

  it("does not echo the identity number in its error message", () => {
    // Error messages reach logs; a rejected-but-real BVN must not land there.
    try {
      hashBvn("12345678901234");
    } catch (error) {
      expect((error as Error).message).not.toContain("12345678901234");
    }
  });

  it("compares digests without leaking timing", () => {
    const digest = hashBvn("55555555555");
    expect(identityMatches(digest, digest)).toBe(true);
    expect(identityMatches(digest, hashBvn("66666666666"))).toBe(false);
    expect(identityMatches(digest, "short")).toBe(false);
  });

  it("masks all but the last four digits", () => {
    expect(maskIdentity("22233344455")).toBe("*******4455");
  });
});

describe("KYC verification", () => {
  it("stores only the digest, never the identity number", async () => {
    const ctx = context();
    const service = new KycService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 0n);
    const number = bvn();

    await service.verifyIdentity({ userId, bvn: number, provider: "DOJAH", level: 2 });

    // §7: raw BVN/NIN in plaintext must never happen. Scan the whole row.
    const rows = await ctx.database.execute<{ row: string }>(sql`
      SELECT kyc_records::text AS row FROM kyc_records WHERE user_id = ${userId}::uuid
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).not.toContain(number);
    expect(rows[0]!.row).toContain(hashBvn(number));
  }, 120_000);

  it("raises the account tier", async () => {
    const ctx = context();
    const service = new KycService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 0n);

    expect(await service.tierOf(userId)).toBe(0);
    await service.verifyIdentity({ userId, bvn: bvn(), provider: "DOJAH", level: 2 });
    expect(await service.tierOf(userId)).toBe(2);
  }, 120_000);

  it("never demotes an account that already cleared a higher tier", async () => {
    const ctx = context();
    const service = new KycService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 0n);

    await service.verifyIdentity({ userId, bvn: bvn(), provider: "DOJAH", level: 3 });
    await service.verifyIdentity({ userId, nin: bvn(), provider: "MANUAL", level: 1 });

    // A later low-tier check must not quietly strip a withdrawal ceiling the
    // user has already qualified for.
    expect(await service.tierOf(userId)).toBe(3);
  }, 120_000);

  it("refuses an identity already attached to another account", async () => {
    const ctx = context();
    const service = new KycService(ctx.wallet);
    const first = await createFundedUser(ctx, 0n);
    const second = await createFundedUser(ctx, 0n);
    const shared = bvn();

    await service.verifyIdentity({ userId: first.userId, bvn: shared, provider: "DOJAH", level: 2 });

    // Multi-accounting: one identity, one account.
    await expect(
      service.verifyIdentity({ userId: second.userId, bvn: shared, provider: "DOJAH", level: 2 }),
    ).rejects.toBeInstanceOf(KycRejectedError);
  }, 120_000);

  it("refuses to verify a self-excluded identity", async () => {
    const ctx = context();
    const service = new KycService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 0n);
    const number = bvn();

    await ctx.database.execute(sql`
      INSERT INTO self_exclusions (identity_hash, until) VALUES (${hashBvn(number)}, NULL)
    `);

    // Without this, an excluded person could open a fresh account and KYC it
    // with the same BVN — and only the placement-time check would stop them.
    await expect(
      service.verifyIdentity({ userId, bvn: number, provider: "DOJAH", level: 2 }),
    ).rejects.toBeInstanceOf(KycRejectedError);
  }, 120_000);

  it("requires at least one identity number", async () => {
    const ctx = context();
    const service = new KycService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 0n);

    await expect(
      service.verifyIdentity({ userId, provider: "MANUAL", level: 1 }),
    ).rejects.toThrow(RangeError);
  }, 120_000);

  it("refuses a malformed identity number before touching the database", async () => {
    const ctx = context();
    const service = new KycService(ctx.wallet);
    const { userId } = await createFundedUser(ctx, 0n);

    await expect(
      service.verifyIdentity({ userId, bvn: "not-a-bvn", provider: "DOJAH", level: 2 }),
    ).rejects.toBeInstanceOf(InvalidIdentityNumberError);

    const rows = await ctx.database.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kyc_records WHERE user_id = ${userId}::uuid
    `);
    expect(Number(rows[0]!.n)).toBe(0);
  }, 120_000);

  it("blocks a raw 11-digit number from reaching the digest column", async () => {
    const ctx = context();
    const { userId } = await createFundedUser(ctx, 0n);

    // The CHECK constraint is the structural backstop behind the service: even
    // a future code path that forgot to hash cannot store a bare BVN.
    await expect(
      ctx.database.execute(sql`
        INSERT INTO kyc_records (user_id, level, bvn_hash, provider)
        VALUES (${userId}::uuid, 2, '22222222222', 'MANUAL'::kyc_provider)
      `),
    ).rejects.toThrow();
  }, 120_000);
});
