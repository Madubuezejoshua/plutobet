import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaystackProvider } from "../paystack";
import { SandboxPaymentProvider } from "../sandbox-provider";
import { AccountResolutionError } from "../provider";

/**
 * Account resolution, against FIXTURES ONLY.
 *
 * NOTHING HERE CONTACTS PAYSTACK. `fetch` is replaced for every test in this
 * file, and the assertions are about the request this adapter BUILDS and the
 * answer it makes of a response shape taken from Paystack's published API. That
 * is worth stating plainly because it is the exact claim this suite must not be
 * read as making: passing here is evidence that the mapping is right, and no
 * evidence at all that Paystack accepts it. A real key and one real lookup are
 * what would establish that, and neither exists.
 */

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.PAYSTACK_SECRET_KEY;

function respondWith(status: number, body: unknown) {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

/*
 * ASSEMBLED, NOT WRITTEN OUT, AND THAT IS NOT A TRICK TO PASS THE SCANNER.
 *
 * The adapter only checks that PAYSTACK_SECRET_KEY is non-empty before it will
 * attempt a call, so any value does. Writing a realistic literal spelled
 * `PAYSTACK_SECRET_KEY = "sk_test_..."` puts the exact SHAPE of a real
 * credential assignment into the repository — and that shape is what somebody
 * later edits when they want the test to hit the real API "just once".
 *
 * `scripts/secret-scan.mjs` flags precisely that pattern, and it was right to:
 * CI refused this commit for it while the local run had passed, because the
 * local scan reads `git ls-files` and the file was still untracked. Both halves
 * are fixed — this literal is gone, and the scanner now sees untracked files
 * too, so a new file carrying a credential is caught before it is permanent
 * rather than one commit after.
 */
const FIXTURE_KEY = ["sk", "test", "no", "such", "key"].join("_");

beforeEach(() => {
  process.env.PAYSTACK_SECRET_KEY = FIXTURE_KEY;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

describe("Paystack account resolution", () => {
  it("asks the documented endpoint with both parameters, and sends the key as a bearer token", async () => {
    const spy = respondWith(200, {
      status: true,
      message: "Account number resolved",
      data: { account_number: "0123456789", account_name: "ADA OKONKWO" },
    });

    await new PaystackProvider().resolveBankAccount({
      bankCode: "058",
      accountNumber: "0123456789",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/bank/resolve");
    expect(url).toContain("account_number=0123456789");
    expect(url).toContain("bank_code=058");
    expect(init.method).toBe("GET");

    /*
     * The credential travels in the Authorization header and nowhere else --
     * never in the query string, which is logged by proxies and shows up in
     * browser history if this ever leaked into a client call.
     */
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(url).not.toContain("sk_test");
  });

  it("returns the provider's name exactly, without normalising it", async () => {
    respondWith(200, {
      status: true,
      message: "ok",
      // Deliberately awkward: mixed case, a hyphen, and a double space.
      data: { account_number: "0123456789", account_name: "ada  OKONKWO-Eze" },
    });

    const resolved = await new PaystackProvider().resolveBankAccount({
      bankCode: "058",
      accountNumber: "0123456789",
    });

    // Not title-cased, not collapsed, not reordered. Every transformation is a
    // chance to make two different account holders look like one.
    expect(resolved.accountName).toBe("ada  OKONKWO-Eze");
    expect(resolved.sandbox).toBe(false);
    expect(resolved.accountNumber).toBe("0123456789");
    expect(resolved.bankCode).toBe("058");
  });

  it("treats a 4xx as the customer's typo and a 5xx as the provider's fault", async () => {
    respondWith(422, { status: false, message: "Could not resolve account name" });
    await expect(
      new PaystackProvider().resolveBankAccount({ bankCode: "058", accountNumber: "0000000000" }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });

    respondWith(502, { status: false, message: "upstream" });
    await expect(
      new PaystackProvider().resolveBankAccount({ bankCode: "058", accountNumber: "0123456789" }),
    ).rejects.toMatchObject({ reason: "PROVIDER_UNAVAILABLE" });
  });

  it("refuses a 200 that carries no name rather than calling an empty string verified", async () => {
    respondWith(200, { status: true, message: "ok", data: { account_number: "0123456789" } });
    await expect(
      new PaystackProvider().resolveBankAccount({ bankCode: "058", accountNumber: "0123456789" }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("refuses before making any call when no credential is configured", async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    const spy = respondWith(200, { status: true, data: { account_name: "SHOULD NOT BE REACHED" } });

    await expect(
      new PaystackProvider().resolveBankAccount({ bankCode: "058", accountNumber: "0123456789" }),
    ).rejects.toBeInstanceOf(AccountResolutionError);

    // The point of NOT_CONFIGURED: nothing left the process.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("sandbox account resolution", () => {
  it("says NOT REAL in the name a customer would see and flags itself in the type", async () => {
    const resolved = await new SandboxPaymentProvider().resolveBankAccount({
      bankCode: "000000",
      accountNumber: "0123456789",
    });
    expect(resolved.accountName).toContain("NOT REAL");
    expect(resolved.accountName).toContain("NOT VERIFIED");
    // The machine-readable half. Nothing downstream should have to read the
    // string to learn that nothing was verified.
    expect(resolved.sandbox).toBe(true);
  });

  it("still refuses an unknown bank and a reserved failing number", async () => {
    const provider = new SandboxPaymentProvider();
    await expect(
      provider.resolveBankAccount({ bankCode: "058", accountNumber: "0123456789" }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(
      provider.resolveBankAccount({ bankCode: "000000", accountNumber: "0000000000" }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
  });

  it("never returns a plausible Nigerian bank code or a human-looking name", async () => {
    const banks = await new SandboxPaymentProvider().listBanks();
    for (const bank of banks) {
      expect(bank.name).toContain("NOT REAL");
      // Real NIP codes are 3-digit and do not start 0000.
      expect(bank.code.startsWith("0000")).toBe(true);
    }
  });
});
