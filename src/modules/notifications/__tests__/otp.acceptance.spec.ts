import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimiter } from "@/lib/api/rate-limit";
import Redis from "ioredis";
import {
  closeBettingContexts,
  createBettingContext,
  type BettingContext,
} from "@/modules/betting/__tests__/helpers";
import { OtpError, OtpService } from "../otp.service";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "../provider";

const IP = "102.89.0.1";
const contexts: BettingContext[] = [];
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

beforeAll(() => {
  process.env.AUTH_SECRET ??= "test-auth-secret-at-least-32-characters!!";
});

afterAll(async () => {
  await closeBettingContexts(contexts);
  await redis.quit();
});

/** Each service gets its own rate-limit namespace so tests cannot throttle each other. */
function makeService(): { service: OtpService; sms: ConsoleSmsProvider; ctx: BettingContext } {
  const ctx = createBettingContext();
  contexts.push(ctx);
  const sms = new ConsoleSmsProvider();
  const limiter = new RateLimiter(redis, `test:otp:${randomUUID()}`);
  return {
    service: new OtpService(ctx.wallet, sms, new ConsoleEmailProvider(), limiter),
    sms,
    ctx,
  };
}

/** A distinct valid MTN number per test. */
function phone(): string {
  return `0803${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
}

describe("OTP issue and verify", () => {
  it("issues a code that verifies once", async () => {
    const { service } = makeService();
    const destination = phone();

    const issued = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });
    expect(issued.destination).toBe(`+234${destination.slice(1)}`);
    expect(issued.devCode).toMatch(/^\d{6}$/);

    await expect(
      service.verify({
        destination,
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        code: issued.devCode!,
      }),
    ).resolves.toBeDefined();

    // Single use: a code observed in transit must not be replayable.
    await expect(
      service.verify({
        destination,
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        code: issued.devCode!,
      }),
    ).rejects.toBeInstanceOf(OtpError);
  }, 120_000);

  it("accepts the code however the number was typed", async () => {
    const { service } = makeService();
    const issued = await service.issue({
      destination: "08034445566",
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });

    // Issued against one format, verified against another — normalisation
    // must make these the same destination.
    await expect(
      service.verify({
        destination: "+234 803 444 5566",
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        code: issued.devCode!,
      }),
    ).resolves.toBeDefined();
  }, 120_000);

  it("never stores the code in the clear", async () => {
    const { service, ctx } = makeService();
    const destination = phone();
    const issued = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });

    // A leaked table must not hand over working codes — and support staff
    // reading one out of the database IS the attack OTP exists to stop.
    const rows = await ctx.database.execute<{ row: string }>(sql`
      SELECT otp_codes::text AS row FROM otp_codes
      WHERE destination = ${`+234${destination.slice(1)}`}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).not.toContain(issued.devCode!);
  }, 120_000);

  it("rejects a wrong code and counts the attempt", async () => {
    const { service, ctx } = makeService();
    const destination = phone();
    const issued = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });
    const wrong = issued.devCode === "000000" ? "111111" : "000000";

    await expect(
      service.verify({ destination, channel: "SMS", purpose: "PHONE_VERIFY", code: wrong }),
    ).rejects.toBeInstanceOf(OtpError);

    const rows = await ctx.database.execute<{ attempts: number }>(sql`
      SELECT attempts FROM otp_codes WHERE destination = ${`+234${destination.slice(1)}`}
    `);
    expect(rows[0]!.attempts).toBe(1);
  }, 120_000);

  it("locks the code after the attempt cap, even if the right code arrives later", async () => {
    const { service } = makeService();
    const destination = phone();
    const issued = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });
    const wrong = issued.devCode === "000000" ? "111111" : "000000";

    // Six digits is 10^6 — only the cap stops the keyspace being walked.
    for (let i = 0; i < 5; i++) {
      await expect(
        service.verify({ destination, channel: "SMS", purpose: "PHONE_VERIFY", code: wrong }),
      ).rejects.toBeInstanceOf(OtpError);
    }

    await expect(
      service.verify({
        destination,
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        code: issued.devCode!,
      }),
    ).rejects.toBeInstanceOf(OtpError);
  }, 120_000);

  it("invalidates the previous code when a new one is issued", async () => {
    const { service } = makeService();
    const destination = phone();

    const first = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });
    const second = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });

    // "Resend" must not leave several live codes and multiply an attacker's
    // chances.
    await expect(
      service.verify({ destination, channel: "SMS", purpose: "PHONE_VERIFY", code: first.devCode! }),
    ).rejects.toBeInstanceOf(OtpError);
    await expect(
      service.verify({
        destination,
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        code: second.devCode!,
      }),
    ).resolves.toBeDefined();
  }, 120_000);

  it("will not accept a code issued for a different purpose", async () => {
    const { service } = makeService();
    const destination = phone();
    const issued = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });

    // Purpose is bound into the digest, so a signup code cannot be replayed
    // to authorise a withdrawal.
    await expect(
      service.verify({
        destination,
        channel: "SMS",
        purpose: "WITHDRAWAL_CONFIRM",
        code: issued.devCode!,
      }),
    ).rejects.toBeInstanceOf(OtpError);
  }, 120_000);

  it("refuses an expired code", async () => {
    const { service, ctx } = makeService();
    const destination = phone();
    const issued = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });

    await ctx.database.execute(sql`
      UPDATE otp_codes SET expires_at = now() - interval '1 minute'
      WHERE destination = ${`+234${destination.slice(1)}`}
    `);

    await expect(
      service.verify({
        destination,
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        code: issued.devCode!,
      }),
    ).rejects.toBeInstanceOf(OtpError);
  }, 120_000);
});

describe("OTP send throttling", () => {
  it("stops one number being bombarded with paid SMS", async () => {
    const { service, sms } = makeService();
    const destination = phone();

    for (let i = 0; i < 3; i++) {
      await service.issue({ destination, channel: "SMS", purpose: "PHONE_VERIFY", ip: IP });
    }

    // Unthrottled, this endpoint is both a bill and a way to harass someone
    // else's phone.
    await expect(
      service.issue({ destination, channel: "SMS", purpose: "PHONE_VERIFY", ip: IP }),
    ).rejects.toBeInstanceOf(OtpError);

    // The refused request must not have cost a message.
    expect(sms.sent).toHaveLength(3);
  }, 120_000);
});

describe("delivery log", () => {
  it("records the send without recording the code", async () => {
    const { service, ctx } = makeService();
    const destination = phone();
    const issued = await service.issue({
      destination,
      channel: "SMS",
      purpose: "PHONE_VERIFY",
      ip: IP,
    });

    const rows = await ctx.database.execute<{ row: string; status: string }>(sql`
      SELECT notification_deliveries::text AS row, status::text AS status
      FROM notification_deliveries
      WHERE destination = ${`+234${destination.slice(1)}`}
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("SENT");
    // The log exists so support can answer "I never got the code" — it must
    // not become a second place the code is readable.
    expect(rows[0]!.row).not.toContain(issued.devCode!);
  }, 120_000);
});
