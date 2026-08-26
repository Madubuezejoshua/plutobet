import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ZodError } from "zod";
import { AccountNotEligibleError, BetRejectedError } from "@/modules/betting/errors";
import { CasinoError } from "@/modules/casino/errors";
import { RgViolationError } from "@/modules/responsible/errors";
import { ActiveSessionRequiredError, requireActiveSession } from "@/modules/auth/session";
import { InsufficientFundsError } from "@/modules/wallet/errors";
import { WithdrawalRejectedError } from "@/modules/payments/errors";
import { rateLimiter, type RateLimitRule } from "./rate-limit";

/**
 * Shared route plumbing: authentication, rate limiting, and turning typed
 * domain errors into HTTP responses.
 *
 * The error mapping lives in ONE place on purpose. Scattered try/catch blocks
 * drift, and the failure mode is a route that leaks an internal message — a
 * stack trace, a SQL fragment, a wallet id — to whoever poked it.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Best-effort client address.
 *
 * x-forwarded-for is client-controlled unless a trusted proxy overwrites it.
 * Vercel does, so the leftmost entry is usable there — but this must never be
 * the only thing an authorization decision rests on.
 */
export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "0.0.0.0";
}

function toResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ActiveSessionRequiredError) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", issues: error.issues.map((i) => ({ path: i.path, message: i.message })) },
      { status: 422 },
    );
  }

  // Responsible-gambling refusals are 403 and DO carry their message: the
  // player needs to know a limit or exclusion stopped them, not just that
  // something failed.
  if (error instanceof RgViolationError) {
    return NextResponse.json(
      { error: `RG_${error.limitType}`, message: error.message },
      { status: 403 },
    );
  }
  if (error instanceof AccountNotEligibleError) {
    return NextResponse.json({ error: "ACCOUNT_NOT_ELIGIBLE", message: error.message }, { status: 403 });
  }
  if (error instanceof InsufficientFundsError) {
    // Deliberately does not echo the balance — the client already knows it,
    // and an error body is a poor place to restate account state.
    return NextResponse.json({ error: "INSUFFICIENT_FUNDS" }, { status: 402 });
  }
  if (error instanceof BetRejectedError) {
    return NextResponse.json({ error: error.name, message: error.message }, { status: 409 });
  }
  if (error instanceof WithdrawalRejectedError) {
    return NextResponse.json({ error: error.name, message: error.message }, { status: 409 });
  }
  if (error instanceof CasinoError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
  }

  // Anything unrecognised is a bug. Log it server-side, tell the client
  // nothing: an unmapped error message is exactly where internals leak.
  console.error("[api] unhandled error", error);
  return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
}

export interface RouteContext {
  request: NextRequest;
  ip: string;
}

export interface AuthedRouteContext extends RouteContext {
  userId: string;
}

/** Wraps a public route: rate limiting by IP, plus error mapping. */
export function publicRoute(
  bucket: string,
  rule: RateLimitRule,
  handler: (context: RouteContext) => Promise<NextResponse>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      const ip = clientIp(request);
      const outcome = await rateLimiter.consume(bucket, ip, rule);
      if (!outcome.allowed) {
        return NextResponse.json(
          { error: "RATE_LIMITED" },
          { status: 429, headers: { "retry-after": String(outcome.retryAfterSeconds) } },
        );
      }
      return await handler({ request, ip });
    } catch (error) {
      return toResponse(error);
    }
  };
}

/**
 * Wraps an authenticated route.
 *
 * Rate limited by USER id rather than IP: shared mobile networks in Nigeria
 * put a great many legitimate players behind one address, so IP-bucketing a
 * logged-in route would throttle real users to protect against an attacker
 * who can simply register again.
 */
export function authedRoute(
  bucket: string,
  rule: RateLimitRule,
  handler: (context: AuthedRouteContext) => Promise<NextResponse>,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      const session = await requireActiveSession();
      const userId = session.user.id;
      const ip = clientIp(request);

      const outcome = await rateLimiter.consume(bucket, userId, rule);
      if (!outcome.allowed) {
        return NextResponse.json(
          { error: "RATE_LIMITED" },
          { status: 429, headers: { "retry-after": String(outcome.retryAfterSeconds) } },
        );
      }
      return await handler({ request, ip, userId });
    } catch (error) {
      return toResponse(error);
    }
  };
}

/** BigInt is not JSON-serialisable; money crosses the wire as a string. */
export function money(value: bigint): string {
  return value.toString();
}
