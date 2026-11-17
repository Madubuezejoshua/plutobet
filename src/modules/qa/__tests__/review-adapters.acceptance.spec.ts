import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReviewOnlyError,
  assertReviewEnvironment,
  isReviewEnvironment,
  reviewEnvironmentRefusal,
} from "@/lib/review-mode";
import {
  ReviewMailboxEmailProvider,
  ReviewMailboxSmsProvider,
  clearMailbox,
  codeIn,
  latestMessageFor,
  reviewMailboxEnabled,
} from "@/modules/notifications/review-mailbox";

/**
 * THE REVIEW ADAPTERS MUST BE UNREACHABLE ANYWHERE THEY COULD DO HARM.
 *
 * A local delivery adapter and a local document store are a genuine risk: the
 * first one exists precisely because it does NOT send a real message, and the
 * second one exists because it does NOT write to the bucket holding customers'
 * identity documents. If either could run on a deployment, the product would
 * silently stop sending verification codes to the people who need them and
 * start storing passports on an ephemeral filesystem.
 *
 * So the gate is tested one condition at a time. Testing the four together
 * would pass for the wrong reason the moment any one of them stopped working —
 * which is exactly how a defence-in-depth arrangement quietly becomes a single
 * point of failure that nobody notices.
 */

type Env = Record<string, string | undefined>;

const TOUCHED = [
  "PLUTOBET_ENVIRONMENT",
  "PLUTOBET_REVIEW_ADAPTERS",
  "VERCEL",
  "VERCEL_ENV",
  "RAILWAY_ENVIRONMENT",
  "KUBERNETES_SERVICE_HOST",
  "TERMII_API_KEY",
  "RESEND_API_KEY",
  "PAYSTACK_SECRET_KEY",
  "B2_BUCKET",
  "B2_KEY_ID",
  "B2_APPLICATION_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_SIGNING_KEY",
  "ODDS_API_KEY",
];

let saved: Env = {};

function reviewEnvironment(): void {
  for (const name of TOUCHED) delete (process.env as Env)[name];
  (process.env as Env).PLUTOBET_ENVIRONMENT = "review";
  (process.env as Env).PLUTOBET_REVIEW_ADAPTERS = "1";
}

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as Env)[name];
    else (process.env as Env)[name] = value;
  }
});

describe("the review-environment gate", () => {
  it("refuses when PLUTOBET_ENVIRONMENT is anything but review", () => {
    reviewEnvironment();
    expect(isReviewEnvironment()).toBe(true);

    for (const value of ["production", "development", "REVIEW", "review ", undefined]) {
      if (value === undefined) delete (process.env as Env).PLUTOBET_ENVIRONMENT;
      else (process.env as Env).PLUTOBET_ENVIRONMENT = value;
      expect(isReviewEnvironment(), `accepted PLUTOBET_ENVIRONMENT=${String(value)}`).toBe(false);
    }
  });

  it("refuses when the second switch is not explicitly on", () => {
    reviewEnvironment();
    for (const value of ["0", "true", "yes", "", undefined]) {
      if (value === undefined) delete (process.env as Env).PLUTOBET_REVIEW_ADAPTERS;
      else (process.env as Env).PLUTOBET_REVIEW_ADAPTERS = value;
      expect(isReviewEnvironment(), `accepted PLUTOBET_REVIEW_ADAPTERS=${String(value)}`).toBe(
        false,
      );
    }
  });

  it("refuses on every hosting platform it can recognise, even when both switches are on", () => {
    for (const marker of ["VERCEL", "VERCEL_ENV", "RAILWAY_ENVIRONMENT", "KUBERNETES_SERVICE_HOST"]) {
      reviewEnvironment();
      (process.env as Env)[marker] = "1";
      expect(isReviewEnvironment(), `accepted a review environment with ${marker} set`).toBe(false);
      expect(reviewEnvironmentRefusal()).toContain(marker);
    }
  });

  it("refuses whenever a live provider credential is present", () => {
    /*
     * THE CONDITION THAT CANNOT BE FORGED ALONGSIDE THE HARM.
     *
     * The three above are environment variables, and a determined
     * misconfiguration can set any of them. This one is different in kind: a
     * process holding a Termii key CAN send a real SMS, and a process holding
     * B2 credentials CAN write to the bucket of customers' identity documents.
     * Refusing the fake adapters exactly when the real ones are reachable means
     * the dangerous arrangement — a fake adapter sitting next to a live
     * credential — is not expressible.
     */
    for (const credential of [
      "TERMII_API_KEY",
      "RESEND_API_KEY",
      "PAYSTACK_SECRET_KEY",
      "B2_BUCKET",
      "B2_KEY_ID",
      "B2_APPLICATION_KEY",
      "UPSTASH_REDIS_REST_TOKEN",
      "INNGEST_SIGNING_KEY",
      "ODDS_API_KEY",
    ]) {
      reviewEnvironment();
      (process.env as Env)[credential] = "a-value-shaped-like-a-key";
      expect(isReviewEnvironment(), `accepted a review environment with ${credential} set`).toBe(
        false,
      );
      expect(reviewEnvironmentRefusal()).toContain(credential);
    }
  });

  it("names which condition failed rather than saying only 'not a review server'", () => {
    reviewEnvironment();
    (process.env as Env).VERCEL_ENV = "production";
    const refusal = reviewEnvironmentRefusal();
    expect(refusal).toBeTruthy();
    expect(refusal).toMatch(/hosting platform/);
  });

  it("throws a typed error from assertReviewEnvironment outside a review server", () => {
    delete (process.env as Env).PLUTOBET_ENVIRONMENT;
    expect(() => assertReviewEnvironment("the thing")).toThrow(ReviewOnlyError);
    try {
      assertReviewEnvironment("the thing");
    } catch (error) {
      expect((error as Error).message).toContain("the thing");
    }
  });
});

describe("the review mailbox", () => {
  it("refuses to accept a message outside a review environment", async () => {
    delete (process.env as Env).PLUTOBET_ENVIRONMENT;
    expect(reviewMailboxEnabled()).toBe(false);
    await expect(new ReviewMailboxSmsProvider().send("+2348000000000", "123456 is your code")).rejects.toThrow(
      ReviewOnlyError,
    );
    await expect(
      new ReviewMailboxEmailProvider().send({
        to: "someone@review.local",
        subject: "code",
        text: "123456 is your code",
      }),
    ).rejects.toThrow(ReviewOnlyError);
  });

  it("refuses to be READ outside a review environment", () => {
    reviewEnvironment();
    clearMailbox();
    delete (process.env as Env).PLUTOBET_ENVIRONMENT;
    expect(() => latestMessageFor("someone@review.local")).toThrow(ReviewOnlyError);
  });

  it("is not called 'console', because that name would put the code back in the response", () => {
    /*
     * `OtpService.issue` decides whether to return `devCode` by comparing the
     * provider name against "console". Renaming this adapter to that string
     * would hand the one-time code straight back to whoever requested it — the
     * exact hole the mailbox exists to avoid — and nothing else in the codebase
     * would notice. That is why the name is asserted rather than assumed.
     */
    expect(new ReviewMailboxSmsProvider().name).toBe("review-mailbox");
    expect(new ReviewMailboxEmailProvider().name).toBe("review-mailbox");
  });

  it("hands back the most recent message, not the first", async () => {
    reviewEnvironment();
    clearMailbox();
    const sms = new ReviewMailboxSmsProvider();
    await sms.send("+2348000000000", "111111 is your Bet Platform code.");
    await sms.send("+2348000000000", "222222 is your Bet Platform code.");

    // `issue()` invalidates any previous active code before writing a new one,
    // so an older message holds a code that no longer verifies. Returning it
    // would make "resend" untestable and look like a broken OTP.
    const latest = latestMessageFor("+2348000000000");
    expect(codeIn(latest!)).toBe("222222");
  });

  it("keeps one destination's messages away from another's", async () => {
    reviewEnvironment();
    clearMailbox();
    const email = new ReviewMailboxEmailProvider();
    await email.send({ to: "a@review.local", subject: "code", text: "333333 is your code." });
    await email.send({ to: "b@review.local", subject: "code", text: "444444 is your code." });

    expect(codeIn(latestMessageFor("a@review.local")!)).toBe("333333");
    expect(codeIn(latestMessageFor("b@review.local")!)).toBe("444444");
    expect(latestMessageFor("c@review.local")).toBeNull();
  });
});
