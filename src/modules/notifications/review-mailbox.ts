import { assertReviewEnvironment, isReviewEnvironment } from "@/lib/review-mode";
import type { EmailProvider, SendResult, SmsProvider } from "./provider";

/**
 * A local mailbox that stands in for Termii and Resend on a review server.
 *
 * WHAT PROBLEM IT SOLVES. The console providers hand the one-time code back in
 * the API response (`devCode`), which is why `otp.service` refuses them under a
 * production build. The review server IS a production build, so registration,
 * password reset, phone verification and email verification had no browser
 * coverage at all — every one of them was written down as
 * `IMPLEMENTED_NOT_LIVE_TESTED` next to a control customers use daily.
 *
 * The mailbox breaks that stalemate WITHOUT reopening the hole. The code never
 * appears in the response to the request that caused it. It goes into a
 * separate store, readable only through `/api/qa/mailbox`, which refuses
 * outside a review environment exactly as this adapter does. A browser test
 * therefore does what a customer does: ask for a code, go and look somewhere
 * else for it, come back and type it in. An attacker on a real deployment gets
 * neither half.
 *
 * IN MEMORY, NOT ON DISK, DELIBERATELY. These messages contain live one-time
 * codes. A file under `artifacts/` is one careless `git add -A` from a code in
 * the history, and the value of writing it down is zero — the only reader is a
 * route in this same process. It dies with the server, which for a disposable
 * review server is the correct lifetime.
 */

export interface MailboxMessage {
  at: string;
  channel: "SMS" | "EMAIL";
  destination: string;
  subject: string | null;
  body: string;
}

/**
 * Stashed on `globalThis` rather than held in a module local.
 *
 * Next.js can evaluate the same module in more than one bundle — a route
 * handler's graph and a server component's graph need not share an instance —
 * and two instances would mean the adapter writes into one mailbox while the
 * QA route reads an empty other one. That failure looks exactly like "the code
 * never arrived", which is the most confusing possible symptom.
 */
const KEY = Symbol.for("plutobet.review.mailbox");
type Holder = { [KEY]?: MailboxMessage[] };

/** Bounded: a run sends a few dozen codes and nothing needs the hundredth. */
const CAPACITY = 200;

function store(): MailboxMessage[] {
  const holder = globalThis as unknown as Holder;
  holder[KEY] ??= [];
  return holder[KEY];
}

function deliver(message: MailboxMessage): void {
  // Belt and braces: the providers below are only ever CONSTRUCTED in a review
  // environment, but a construction-time check protects the decision and this
  // protects the act. They are different moments and the environment could in
  // principle change between them.
  assertReviewEnvironment("the review mailbox");
  const box = store();
  box.push(message);
  if (box.length > CAPACITY) box.splice(0, box.length - CAPACITY);
}

/**
 * The most recent message to a destination.
 *
 * Most recent rather than first, because `OtpService.issue` invalidates any
 * previous active code before writing a new one — so an older message in the
 * box holds a code that no longer verifies, and returning it would make
 * "resend" untestable.
 */
export function latestMessageFor(destination: string): MailboxMessage | null {
  assertReviewEnvironment("the review mailbox");
  const normalised = destination.trim().toLowerCase();
  for (let i = store().length - 1; i >= 0; i -= 1) {
    const message = store()[i]!;
    if (message.destination.trim().toLowerCase() === normalised) return message;
  }
  return null;
}

export function clearMailbox(): void {
  assertReviewEnvironment("the review mailbox");
  store().length = 0;
}

/**
 * The six-digit code inside a message body, if there is one.
 *
 * The body is composed by `OtpService.deliver` and is the only place the code
 * exists in plain text. Parsing it here keeps the QA route from having to know
 * the message format.
 */
export function codeIn(message: MailboxMessage): string | null {
  return /\b(\d{6})\b/.exec(message.body)?.[1] ?? null;
}

export class ReviewMailboxSmsProvider implements SmsProvider {
  /*
   * NOT "console". `OtpService.issue` decides whether to return `devCode` by
   * comparing this name against "console", so calling it that would put the
   * code back in the API response — the exact hole this adapter exists to
   * avoid. The name is asserted in review-adapters.acceptance.spec.ts, because
   * a rename here is a security regression and would otherwise be silent.
   */
  readonly name = "review-mailbox";

  async send(to: string, body: string): Promise<SendResult> {
    deliver({ at: new Date().toISOString(), channel: "SMS", destination: to, subject: null, body });
    return { providerRef: `review-mailbox:${Date.now()}` };
  }
}

export class ReviewMailboxEmailProvider implements EmailProvider {
  readonly name = "review-mailbox";

  async send(params: { to: string; subject: string; text: string }): Promise<SendResult> {
    deliver({
      at: new Date().toISOString(),
      channel: "EMAIL",
      destination: params.to,
      subject: params.subject,
      body: params.text,
    });
    return { providerRef: `review-mailbox:${Date.now()}` };
  }
}

/** True when this process should substitute the mailbox for a real vendor. */
export function reviewMailboxEnabled(): boolean {
  return isReviewEnvironment();
}
