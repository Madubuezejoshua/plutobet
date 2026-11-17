/**
 * The one gate every test-only adapter and QA route asks before it does
 * anything.
 *
 * WHY THIS FILE EXISTS. The browser suite runs against a PRODUCTION BUILD
 * (`scripts/review-server.mjs` starts `next start` with `NODE_ENV=production`),
 * because a development build is not the artefact anyone ships. That is the
 * right call and it cost real coverage: `otp.service` refuses its console
 * fallback under a production build — correctly, since that fallback returns
 * the one-time code in the API response — so registration, password reset and
 * every other code-bearing flow could not be completed in a browser at all.
 *
 * So the choice was never "production build or browser coverage". It was
 * "invent a third environment, or keep writing `IMPLEMENTED_NOT_LIVE_TESTED`
 * next to controls a customer uses every day". This is that third environment,
 * and the whole value of it rests on the gate being impossible to satisfy by
 * accident.
 *
 * FOUR CONDITIONS, ALL REQUIRED:
 *
 *   1. `PLUTOBET_ENVIRONMENT` is exactly `review`. Set by review-server.mjs.
 *      Nothing else in the repository sets it, and a deployment that has never
 *      heard of it cannot have it.
 *   2. `PLUTOBET_REVIEW_ADAPTERS` is exactly `1`. A second, separate switch, so
 *      that "this is a review server" and "this review server may substitute
 *      adapters" are two decisions and not one. Naming an environment is the
 *      kind of thing somebody copies between configs; turning on test adapters
 *      is not.
 *   3. No hosting platform is present. `VERCEL`, `VERCEL_ENV`, `RAILWAY_*`,
 *      `RENDER`, `FLY_APP_NAME`, `AWS_EXECUTION_ENV`, `KUBERNETES_SERVICE_HOST`
 *      — if the process is on any of them, this is not a review machine
 *      whatever the variables claim.
 *   4. No real provider credential is configured. If a live Termii, Resend,
 *      Paystack, Backblaze or Upstash credential is in the environment, this
 *      process can reach something real, and a fake adapter next to a real
 *      credential is exactly the arrangement that sends a test SMS to a
 *      stranger.
 *
 * Condition 4 is the one that matters most. Conditions 1-3 can all be forged by
 * a determined misconfiguration; condition 4 cannot be satisfied at the same
 * time as the harm it prevents.
 */

/** Variables that prove the process is running on somebody's platform. */
const HOSTING_MARKERS = [
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "RAILWAY_ENVIRONMENT",
  "RAILWAY_PROJECT_ID",
  "RENDER",
  "FLY_APP_NAME",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_FUNCTION_NAME",
  "KUBERNETES_SERVICE_HOST",
  "DYNO",
] as const;

/**
 * Credentials that can reach a real person, a real bucket or a real bill.
 *
 * Deliberately NOT every provider name — only the ones whose presence means
 * this process could do something that leaves the machine.
 */
const LIVE_PROVIDER_CREDENTIALS = [
  "TERMII_API_KEY",
  "RESEND_API_KEY",
  "PAYSTACK_SECRET_KEY",
  "B2_APPLICATION_KEY",
  "B2_KEY_ID",
  "B2_BUCKET",
  "UPSTASH_REDIS_REST_TOKEN",
  "INNGEST_SIGNING_KEY",
  "ODDS_API_KEY",
] as const;

export class ReviewOnlyError extends Error {
  constructor(what: string, readonly reason: string) {
    super(`${what} is available only on a review server (${reason})`);
    this.name = "ReviewOnlyError";
  }
}

function set(name: string): boolean {
  return String(process.env[name] ?? "").trim() !== "";
}

/**
 * Why this process is NOT a review environment, or `null` if it is one.
 *
 * Returns the reason rather than a boolean so a refusal can say which
 * condition failed — an operator who turns this on and finds it still refusing
 * needs to know which of four things to look at, and "not a review server" is
 * not an answer.
 */
export function reviewEnvironmentRefusal(): string | null {
  if (process.env.PLUTOBET_ENVIRONMENT !== "review") {
    return "PLUTOBET_ENVIRONMENT is not 'review'";
  }
  if (process.env.PLUTOBET_REVIEW_ADAPTERS !== "1") {
    return "PLUTOBET_REVIEW_ADAPTERS is not '1'";
  }
  const hosted = HOSTING_MARKERS.filter(set);
  if (hosted.length > 0) {
    return `running on a hosting platform (${hosted.join(", ")} present)`;
  }
  const live = LIVE_PROVIDER_CREDENTIALS.filter(set);
  if (live.length > 0) {
    // NAMES ONLY, never values. A refusal message is a log line and a log line
    // is not a place for a credential.
    return `live provider credentials are configured (${live.join(", ")})`;
  }
  return null;
}

export function isReviewEnvironment(): boolean {
  return reviewEnvironmentRefusal() === null;
}

/** Throws unless this process is a review server. */
export function assertReviewEnvironment(what: string): void {
  const refusal = reviewEnvironmentRefusal();
  if (refusal) throw new ReviewOnlyError(what, refusal);
}
