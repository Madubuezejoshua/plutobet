import { NextResponse } from "next/server";
import { qaMethodNotAllowed, qaRoute } from "@/lib/api/qa-route";
import { moneyInvariants, MUST_BE_ZERO } from "@/modules/qa/invariants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The money invariants, at the moment a browser journey finishes.
 *
 * WHY NOT JUST RUN THE SCRIPT AFTERWARDS. Because "the ledger balanced when we
 * checked half an hour later" and "the ledger balanced the instant this bet
 * settled" are different claims, and only the second one attributes a failure
 * to the thing that caused it. The gate script runs too, over the whole
 * database; this is the journey asserting its own consequences.
 *
 * Read-only. `moneyInvariants()` is nine SELECTs and writes nothing — a checker
 * that repairs what it finds can no longer tell you the system was broken.
 */
export const GET = qaRoute("invariants", async () => {
  const invariants = await moneyInvariants();
  const violations = MUST_BE_ZERO.filter((key) => invariants[key] !== 0);
  return NextResponse.json({ invariants, violations, clean: violations.length === 0 });
});

/*
 * The verbs this route does not implement, answered through the SAME gate.
 * Without them Next replies 405 before any handler runs, and a 405 next to a
 * 404 tells a stranger the path exists — see `qaMethodNotAllowed`.
 */
export const POST = qaMethodNotAllowed("invariants");
export const PUT = qaMethodNotAllowed("invariants");
export const PATCH = qaMethodNotAllowed("invariants");
export const DELETE = qaMethodNotAllowed("invariants");
