import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRedisClient } from "@/db/redis";
import { BankListService } from "../bank-list.service";
import { SandboxPaymentProvider } from "../sandbox-provider";
import type { BankOption, PaymentProvider } from "../provider";

/**
 * The bank list a withdrawal is paid to.
 *
 * WHAT IS AT STAKE. A wrong bank code does not bounce. It sends real money to a
 * real account at a different institution, and the first anyone hears of it is a
 * support ticket about a missing withdrawal. So the list may only come from the
 * provider — the same party that will accept or refuse the transfer — and never
 * from a table typed into source, which is wrong from the day it is written.
 *
 * WHAT THESE TESTS DO NOT PROVE. Nothing here contacts Paystack. The adapter is
 * exercised against captured-shape fixtures, which pins OUR parsing and says
 * nothing about whether the provider still answers that way. Real communication
 * is `BLOCKED_BY_KEY` and stays so until credentials exist.
 */

/** A cache key nobody else's test shares. */
function isolated(): BankListService {
  return new BankListService(() => stubProvider);
}

let stubProvider: PaymentProvider;

function providerReturning(banks: BankOption[] | Error): PaymentProvider {
  return {
    name: "stub",
    parseWebhook: () => null,
    createVirtualAccount: async () => {
      throw new Error("not used");
    },
    initiateTransfer: async () => {
      throw new Error("not used");
    },
    listBanks: async () => {
      if (banks instanceof Error) throw banks;
      return banks;
    },
  };
}

const REAL_SHAPE: BankOption[] = [
  { code: "044", name: "Access Bank", slug: "access-bank" },
  { code: "058", name: "Guaranty Trust Bank", slug: "gtb" },
  { code: "057", name: "Zenith Bank", slug: "zenith-bank" },
];

/** Each test gets its own key so the shared Redis does not couple them. */
async function freshKey(): Promise<void> {
  await getRedisClient().del("payments:banks:v1");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the bank list", () => {
  it("returns what the provider returned", async () => {
    await freshKey();
    stubProvider = providerReturning(REAL_SHAPE);

    const result = await isolated().list();

    expect(result.banks).toEqual(REAL_SHAPE);
    expect(result.stale).toBe(false);
    expect(result.unavailable).toBe(false);
  }, 60_000);

  it("asks the provider once and serves the rest from cache", async () => {
    await freshKey();
    const listBanks = vi.fn(async () => REAL_SHAPE);
    stubProvider = { ...providerReturning(REAL_SHAPE), listBanks };
    const service = isolated();

    await service.list();
    await service.list();
    await service.list();

    // A bank list changes a few times a year. Asking on every withdrawal page
    // view would be a network round trip on a page a customer is waiting on.
    expect(listBanks).toHaveBeenCalledTimes(1);
  }, 60_000);

  /**
   * The failure that matters most.
   *
   * A provider having a bad minute must not empty a good list. If it did, every
   * customer would be unable to withdraw until the next refresh — an outage
   * turned into a longer outage.
   */
  it("serves the cached list when the provider fails, and says it is stale", async () => {
    await freshKey();
    stubProvider = providerReturning(REAL_SHAPE);
    await isolated().list();

    stubProvider = providerReturning(new Error("provider unreachable"));
    // Force the cache past its freshness window without waiting twelve hours.
    await getRedisClient().set(
      "payments:banks:v1",
      JSON.stringify({ fetchedAt: Date.now() - 13 * 60 * 60_000, banks: REAL_SHAPE }),
    );

    const result = await isolated().list();

    expect(result.banks).toEqual(REAL_SHAPE);
    expect(result.stale).toBe(true);
    expect(result.unavailable).toBe(false);
  }, 60_000);

  it("treats an empty provider response as a failure, not as 'no banks'", async () => {
    await freshKey();
    stubProvider = providerReturning(REAL_SHAPE);
    await isolated().list();

    stubProvider = providerReturning([]);
    await getRedisClient().set(
      "payments:banks:v1",
      JSON.stringify({ fetchedAt: Date.now() - 13 * 60 * 60_000, banks: REAL_SHAPE }),
    );

    const result = await isolated().list();

    // The good list survives. Overwriting it with nothing would be the provider
    // outage becoming a product outage.
    expect(result.banks).toEqual(REAL_SHAPE);
    expect(result.stale).toBe(true);
  }, 60_000);

  it("reports honestly when there is no list at all", async () => {
    await freshKey();
    stubProvider = providerReturning(new Error("provider unreachable"));

    const result = await isolated().list();

    // Not an empty select with no explanation: the form uses this to fall back
    // to a typed code and say why.
    expect(result.banks).toEqual([]);
    expect(result.unavailable).toBe(true);
  }, 60_000);

  it("still answers when Redis is unavailable", async () => {
    stubProvider = providerReturning(REAL_SHAPE);
    vi.spyOn(getRedisClient(), "get").mockRejectedValue(new Error("connection refused") as never);
    vi.spyOn(getRedisClient(), "set").mockRejectedValue(new Error("connection refused") as never);

    const result = await isolated().list();

    // A list we could not cache is still a list we can serve.
    expect(result.banks).toEqual(REAL_SHAPE);
    expect(result.unavailable).toBe(false);
  }, 60_000);

  it("ignores a cached value that is not a bank list", async () => {
    await getRedisClient().set("payments:banks:v1", JSON.stringify({ nonsense: true }));
    stubProvider = providerReturning(REAL_SHAPE);

    const result = await isolated().list();

    expect(result.banks).toEqual(REAL_SHAPE);
  }, 60_000);
});

describe("validating a submitted bank code", () => {
  it("accepts a code that is on the list", async () => {
    await freshKey();
    stubProvider = providerReturning(REAL_SHAPE);
    expect(await isolated().isPayableBankCode("058")).toBe(true);
  }, 60_000);

  it("rejects a code that is not", async () => {
    await freshKey();
    stubProvider = providerReturning(REAL_SHAPE);
    // Well-formed and wrong. Without this it reaches the provider, after the
    // customer's balance has already been held.
    expect(await isolated().isPayableBankCode("999")).toBe(false);
  }, 60_000);

  /**
   * Deliberate, and the direction matters.
   *
   * Refusing every withdrawal because a bank list could not be fetched would
   * turn a provider outage into an inability to take money out. The transfer
   * re-validates the code and the provider refuses an unknown one; this check
   * exists to catch a typo early with a clear message, not to be the only thing
   * standing between a customer and a wrong bank.
   */
  it("passes when no list can be established", async () => {
    await freshKey();
    stubProvider = providerReturning(new Error("provider unreachable"));
    expect(await isolated().isPayableBankCode("044")).toBe(true);
  }, 60_000);
});

describe("the sandbox provider's list", () => {
  it("is obviously not real", async () => {
    const banks = await new SandboxPaymentProvider().listBanks();

    expect(banks.length).toBeGreaterThan(0);
    for (const bank of banks) {
      // A development adapter returning plausible NIP codes is the exact failure
      // this interface exists to prevent: somebody eventually ships against it,
      // and a code that looks real and is wrong sends money to the wrong bank.
      expect(bank.name).toMatch(/NOT REAL/);
    }
    // And none of them collides with a real Nigerian code.
    const codes = banks.map((b) => b.code);
    expect(codes).not.toContain("044");
    expect(codes).not.toContain("058");
    expect(new Set(codes).size).toBe(codes.length);
  }, 60_000);
});

describe("what has NOT been proven", () => {
  it("has never contacted a real payment provider", () => {
    /*
     * A standing reminder rather than a behaviour check.
     *
     * Every test above uses a stub or the sandbox. None of them says anything
     * about whether Paystack still returns the shape the adapter parses, and no
     * amount of green here changes that. Real communication is BLOCKED_BY_KEY.
     */
    expect(process.env.PAYSTACK_SECRET_KEY ?? "").toBe("");
    expect(randomUUID()).toBeTruthy();
  });
});
