import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * The browser suite's door into the review-only surface.
 *
 * WHAT THAT SURFACE IS FOR. A browser cannot make ninety minutes pass, read an
 * SMS, suspend a market or fund an account with no payment provider. Those are
 * not gaps in the interface — they are things that happen elsewhere in the
 * world, and without a way to make them happen locally, every flow depending on
 * one stays untested in a browser forever. `src/lib/api/qa-route.ts` explains
 * the four environment conditions plus the per-run key that keep it out of
 * reach anywhere else.
 *
 * THE KEY IS READ FROM DISK, NOT PASSED IN. `scripts/review-server.mjs`
 * generates it into `.env.review.local` — gitignored, per-machine — and the
 * suite reads it from there. That means a test run against anything other than
 * a review server started on this machine simply has no key, and every QA call
 * comes back 404. Nothing to configure, nothing to remember, and no way to
 * point this at a server that is not the one that made the key.
 */

const SECRETS_FILE = path.resolve(".env.review.local");

let cached: string | null | undefined;

export function reviewKey(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (existsSync(SECRETS_FILE)) {
    for (const line of readFileSync(SECRETS_FILE, "utf8").split(/\r?\n/)) {
      const match = /^PLUTOBET_REVIEW_KEY=(.+)$/.exec(line.trim());
      if (match) cached = match[1]!;
    }
  }
  return cached;
}

export function reviewHeaders(): Record<string, string> {
  const key = reviewKey();
  if (!key) {
    throw new Error(
      "No PLUTOBET_REVIEW_KEY in .env.review.local.\n" +
        "Start the review server first (node scripts/review-server.mjs); it generates one.\n" +
        "Refusing to run a test that would silently skip the behaviour it claims to prove.",
    );
  }
  return { "x-plutobet-review-key": key };
}

type Requester = APIRequestContext | Page;

function api(target: Requester): APIRequestContext {
  return "request" in target ? target.request : target;
}

async function post<T>(target: Requester, path: string, data: unknown): Promise<T> {
  const response = await api(target).post(path, {
    data,
    headers: reviewHeaders(),
    failOnStatusCode: false,
  });
  if (!response.ok()) {
    throw new Error(`${path} answered ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export interface DisposableAccount {
  userId: string;
  email: string;
  password: string;
  walletId: string;
  balanceMinor: string;
}

/**
 * A brand-new account nothing else in the run will touch.
 *
 * This is what replaces "we cannot press this button because it would break
 * the rest of the suite". Self-exclusion, cool-off, a password change and
 * revoking every session are all irreversible for the account that takes them
 * and all perfectly testable on an account created three seconds earlier.
 */
export function createAccount(
  target: Requester,
  params: {
    label: string;
    password?: string;
    dateOfBirth?: string | null;
    kycLevel?: number;
    fundMinor?: string;
    status?: "ACTIVE" | "SUSPENDED";
  },
): Promise<DisposableAccount> {
  return post<DisposableAccount>(target, "/api/qa/fixtures", { action: "account", ...params });
}

export function fundAccount(
  target: Requester,
  userId: string,
  amountMinor: string,
): Promise<{ balanceMinor: string }> {
  return post(target, "/api/qa/fixtures", { action: "fund", userId, amountMinor });
}

export interface DisposableEvent {
  eventId: string;
  /** The provider's own id — what `getResults` is asked about. */
  providerEventId: string;
  marketId: string;
  selections: { id: string; key: string; label: string; price: string }[];
  home: string;
  away: string;
}

export function createEvent(
  target: Requester,
  params: {
    label: string;
    startsInHours?: number;
    prices?: [string, string, string];
    /** `review` (default) keeps it off the board; `football` puts it on. */
    sport?: "review" | "football";
  },
): Promise<DisposableEvent> {
  return post<DisposableEvent>(target, "/api/qa/fixtures", { action: "event", ...params });
}

/** Suspends, closes or reprices a selection — what an odds feed does. */
export function setSelection(
  target: Requester,
  params: {
    selectionId: string;
    status?: "OPEN" | "SUSPENDED" | "SETTLED" | "VOID";
    priceDecimal?: string;
  },
): Promise<{ status: string; price: string }> {
  return post(target, "/api/qa/fixtures", { action: "selection", ...params });
}

export function setMarket(
  target: Requester,
  params: { marketId: string; status: "OPEN" | "SUSPENDED" | "SETTLED" | "VOID" },
): Promise<{ status: string }> {
  return post(target, "/api/qa/fixtures", { action: "market", ...params });
}

export interface DriveOutcome {
  ingested: number;
  dispatched: number;
  settleEventRuns: number;
  settleBetRuns: number;
  outbox: Record<string, number>;
  listenerErrors: { event: string; message: string }[];
}

/**
 * Makes a match finish and lets the registered background functions settle it.
 *
 * The only fabricated input is the provider's answer. Everything downstream —
 * the transactional outbox, the dispatcher, `settleEvent`, `settleBet`, the
 * payout, the exposure release, the market closure — is the production code
 * reached the production way.
 */
export function settle(
  target: Requester,
  results: { providerEventId: string; eventId: string; ft?: { home: number; away: number }; cancelled?: boolean }[],
  options: { sweep?: boolean } = {},
): Promise<DriveOutcome> {
  return post<DriveOutcome>(target, "/api/qa/settlement", { results, ...options });
}

export interface InvariantReport {
  invariants: Record<string, number>;
  violations: string[];
  clean: boolean;
}

export async function invariants(target: Requester): Promise<InvariantReport> {
  const response = await api(target).get("/api/qa/invariants", {
    headers: reviewHeaders(),
    failOnStatusCode: false,
  });
  if (!response.ok()) {
    throw new Error(`/api/qa/invariants answered ${response.status()}`);
  }
  return (await response.json()) as InvariantReport;
}

export interface MailboxMessage {
  found: boolean;
  channel: "SMS" | "EMAIL";
  destination: string;
  subject: string | null;
  at: string;
  code: string | null;
}

/**
 * The one-time code that was delivered, read from the local mailbox.
 *
 * Polled rather than read once: delivery is a fire-and-forget write inside the
 * request that issued the code, and a browser that has just seen the form
 * advance may reach here a few milliseconds early.
 */
export async function waitForCode(
  target: Requester,
  destination: string,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const response = await api(target).get(
      `/api/qa/mailbox?destination=${encodeURIComponent(destination)}`,
      { headers: reviewHeaders(), failOnStatusCode: false },
    );
    lastStatus = response.status();
    if (response.ok()) {
      const message = (await response.json()) as MailboxMessage;
      if (message.code) return message.code;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `no one-time code was delivered to ${destination} within ${timeoutMs}ms ` +
      `(last mailbox status ${lastStatus})`,
  );
}

/**
 * A Nigerian mobile number nothing real can be behind.
 *
 * 0700 is not in `MOBILE_PREFIXES`, so it would be REJECTED — the number has to
 * be genuinely valid or registration refuses before any code is issued. 0803 is
 * an MTN prefix; the remaining seven digits are randomised so two runs cannot
 * collide on the same account. The mailbox is the only place a message goes.
 */
export function disposablePhone(): string {
  const tail = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
  return `0803${tail}`;
}

/**
 * Gives this test its own client address, so it gets its own rate budget.
 *
 * WHY THIS IS NEEDED, AND WHY IT IS NOT A WEAKENING. The one-time-code budget
 * is **10 per IP per 15 minutes** — deliberately tight, because issuing a code
 * costs SMS money and registration is the surface a bot uses to mass-create
 * accounts. The whole browser suite runs from ONE address, both projects issue
 * codes, and the suite takes longer than the window: so the eleventh
 * registration in fifteen minutes was refused, no code was delivered, and a
 * test failed for a reason that had nothing to do with what it was testing.
 * It passed in one run and failed in the next, which is the signature of a
 * shared budget rather than a defect.
 *
 * A test that needs a code is a DIFFERENT CUSTOMER, and different customers do
 * not share a connection. Giving each one its own forwarded address is what
 * production looks like, not a hole cut in a control — the limiter still runs,
 * still counts, and still refuses. Its correctness is asserted where it belongs
 * and not skipped here: `security.spec.ts` fires a burst from ONE address and
 * requires it to be shed by refusing, and `security-extended.spec.ts` rotates
 * the header deliberately and records that a proxy which does not overwrite it
 * would let a budget be reset.
 *
 * The alternative — flushing Redis between tests — would have disabled the
 * limiter for the run and hidden exactly the failure the burst test exists to
 * find.
 */
export function isolatedClientHeaders(): Record<string, string> {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return { "x-forwarded-for": `203.0.113.${octet()}.${Date.now() % 251}` };
}

/** The E.164 form the OTP service normalises the above into. */
export function e164(local: string): string {
  return `+234${local.replace(/^0/, "")}`;
}
