import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Withdrawal helpers: a bank the review server actually publishes, and the
 * account name the PROVIDER gives for it.
 *
 * WHY THIS EXISTS. Every withdrawal spec used to post `bankCode: "058"` — a
 * real Nigerian NIP code — with `accountName: "Review Tester"` typed in by the
 * test, and they passed. They passed for the wrong reason twice over:
 *
 *   1. The review server is a production build with no Paystack key, so the
 *      payment provider REFUSED to construct and the bank list could not be
 *      fetched. `isPayableBankCode` deliberately passes when no list can be
 *      established — a provider outage must not stop withdrawals — so an
 *      unknown code sailed through a check that had nothing to check against.
 *   2. The account name was whatever the test said it was, because the route
 *      accepted it from the request body.
 *
 * Both are now closed, so the specs have to do what a customer does: read the
 * list, ask who owns the account, and confirm that answer.
 */

/** The first bank the server actually publishes. Never a hard-coded code. */
export async function firstPayableBank(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/payments/banks");
  expect(response.status(), "the bank list could not be read").toBe(200);
  const body = (await response.json()) as { banks?: { code: string }[] };
  const code = body.banks?.[0]?.code;
  expect(code, "the server published no banks, so no withdrawal can name one").toBeTruthy();
  return code!;
}

export interface ResolvedAccount {
  bankCode: string;
  accountNumber: string;
  /** The provider's answer. The only name a withdrawal will accept. */
  accountName: string;
  sandbox: boolean;
}

/**
 * Asks the server who owns an account, exactly as the form does.
 *
 * The name returned here is the ONLY one `POST /api/withdrawals` will accept:
 * it re-resolves and compares, so a test that invents a name is refused with
 * `ACCOUNT_NAME_CHANGED` — which is the control working, not a broken test.
 */
export async function resolveAccount(
  request: APIRequestContext,
  accountNumber = "0123456789",
  bankCode?: string,
): Promise<ResolvedAccount> {
  const code = bankCode ?? (await firstPayableBank(request));
  const response = await request.post("/api/payments/resolve-account", {
    data: { accountNumber, bankCode: code },
    failOnStatusCode: false,
  });
  expect(
    response.status(),
    `the account could not be resolved: ${await response.text()}`,
  ).toBe(200);
  const body = (await response.json()) as { accountName: string; sandbox: boolean };
  return { bankCode: code, accountNumber, accountName: body.accountName, sandbox: body.sandbox };
}

/** A withdrawal body carrying the provider's name, ready to post. */
export function withdrawalBody(
  account: ResolvedAccount,
  amountMinor: string,
  idempotencyKey: string,
) {
  return {
    amountMinor,
    bankCode: account.bankCode,
    accountNumber: account.accountNumber,
    confirmedAccountName: account.accountName,
    idempotencyKey,
  };
}
