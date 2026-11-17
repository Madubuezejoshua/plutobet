/**
 * Phase 7: place a real pre-match bet through the production placement path.
 *
 *   npx tsx scripts/qa-place-bet.ts <userId> <stakeKobo>
 *
 * Uses placementService.placeBet — the same service the public API route
 * calls — against a real 1x2 selection ingested from odds-api.io. No status is
 * written by hand and no balance is touched directly.
 *
 * Also exercises the negative paths that matter at placement time: a stake
 * larger than the balance, a zero stake, a stale price, and a duplicate
 * submit under the same idempotency key.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { placementService } from "@/modules/betting/placement.service";

const IP = "102.89.0.1";

async function cashWallet(userId: string) {
  const [row] = await db.execute<{ id: string; balance: string }>(sql`
    SELECT id::text, cached_balance_minor::text AS balance
    FROM wallets
    WHERE user_id = ${userId}::uuid AND kind = 'USER' AND currency = 'NGN' AND bucket = 'CASH'
  `);
  if (!row) throw new Error("no CASH wallet");
  return { id: row.id, balance: BigInt(row.balance) };
}

/** An upcoming, open 1x2 selection with a real price. */
async function pickSelection() {
  const [row] = await db.execute<{
    selection_id: string;
    sel: string;
    price: string;
    home: string;
    away: string;
    league: string;
    starts_at: Date;
    event_id: string;
  }>(sql`
    SELECT s.id::text AS selection_id, s.key AS sel,
           s.current_price_decimal::text AS price,
           e.home, e.away, e.league, e.starts_at, e.id::text AS event_id
    FROM selections s
    JOIN markets m ON m.id = s.market_id
    JOIN events e ON e.id = m.event_id
    WHERE m.key = '1x2'
      AND m.status = 'OPEN'
      AND s.status = 'OPEN'
      AND s.current_price_decimal > 1
      AND e.starts_at > now() + interval '30 minutes'
      AND e.status = 'PENDING'
    ORDER BY e.starts_at
    LIMIT 1
  `);
  return row ?? null;
}

async function main() {
  const userId = process.argv[2]?.trim();
  const stakeRaw = process.argv[3]?.trim() ?? "20000";
  if (!userId) throw new Error("usage: qa-place-bet.ts <userId> [stakeKobo]");
  if (!/^\d+$/.test(stakeRaw)) throw new Error("stake must be whole kobo");
  const stakeMinor = BigInt(stakeRaw);

  const selection = await pickSelection();
  if (!selection) {
    console.log("BLOCKED: no open 1x2 selection on an upcoming event — run the odds sync first");
    process.exit(2);
  }

  console.log("EVENT");
  console.log(`  ${selection.home} v ${selection.away} (${selection.league})`);
  console.log(`  kick-off : ${new Date(selection.starts_at).toISOString()}`);
  console.log(`  selection: ${selection.sel} @ ${selection.price}`);

  const before = await cashWallet(userId);
  console.log(`\nBALANCE BEFORE: ${before.balance} kobo`);

  // ---- negative: stake larger than the balance -------------------------
  try {
    await placementService.placeBet({
      userId,
      walletId: before.id,
      stakeMinor: before.balance + 1n,
      legs: [{ selectionId: selection.selection_id, odds: selection.price }],
      ip: IP,
      idempotencyKey: `qa-overdraw:${randomUUID()}`,
    });
    console.log("\nNEGATIVE overdraw : FAILED — the bet was accepted");
  } catch (error) {
    console.log(`\nNEGATIVE overdraw : refused (${(error as Error).constructor.name})`);
  }

  // ---- negative: zero stake --------------------------------------------
  try {
    await placementService.placeBet({
      userId,
      walletId: before.id,
      stakeMinor: 0n,
      legs: [{ selectionId: selection.selection_id, odds: selection.price }],
      ip: IP,
      idempotencyKey: `qa-zero:${randomUUID()}`,
    });
    console.log("NEGATIVE zero stake: FAILED — the bet was accepted");
  } catch (error) {
    console.log(`NEGATIVE zero stake: refused (${(error as Error).constructor.name})`);
  }

  // ---- negative: stale odds --------------------------------------------
  const stalePrice = (Number(selection.price) + 0.75).toFixed(3);
  try {
    await placementService.placeBet({
      userId,
      walletId: before.id,
      stakeMinor: 1_000n,
      legs: [{ selectionId: selection.selection_id, odds: stalePrice }],
      ip: IP,
      idempotencyKey: `qa-stale:${randomUUID()}`,
    });
    console.log("NEGATIVE stale odds: FAILED — a price the user never saw was accepted");
  } catch (error) {
    console.log(`NEGATIVE stale odds: refused (${(error as Error).constructor.name})`);
  }

  // ---- the real bet ----------------------------------------------------
  const slipKey = `qa-bet:${randomUUID()}`;
  const placed = await placementService.placeBet({
    userId,
    walletId: before.id,
    stakeMinor,
    legs: [{ selectionId: selection.selection_id, odds: selection.price }],
    ip: IP,
    idempotencyKey: slipKey,
  });

  console.log(`\nBET PLACED`);
  console.log(`  betId          : ${placed.betId}`);
  console.log(`  stake          : ${placed.stakeMinor} kobo`);
  console.log(`  locked odds    : ${placed.totalOddsDecimal}`);
  console.log(`  potential return: ${placed.potentialReturnMinor} kobo`);
  console.log(`  stakeTxnId     : ${placed.stakeTxnId}`);
  console.log(`  balance after  : ${placed.balanceAfterMinor} kobo`);

  // ---- duplicate submit, same key --------------------------------------
  const replay = await placementService.placeBet({
    userId,
    walletId: before.id,
    stakeMinor,
    legs: [{ selectionId: selection.selection_id, odds: selection.price }],
    ip: IP,
    idempotencyKey: slipKey,
  });
  console.log(`\nDOUBLE SUBMIT same key -> betId ${replay.betId}`);
  console.log(`  same bet? ${replay.betId === placed.betId ? "YES (one bet only)" : "NO — DUPLICATE CREATED"}`);

  const [count] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM bets WHERE user_id = ${userId}::uuid
  `);
  console.log(`  bets for this user: ${count?.n}`);

  const after = await cashWallet(userId);
  console.log(`\nBALANCE AFTER: ${after.balance} kobo (was ${before.balance})`);

  const [bet] = await db.execute<{ status: string; locked: string; potential: string }>(sql`
    SELECT b.status::text, l.locked_odds_decimal::text AS locked,
           b.potential_return_minor::text AS potential
    FROM bets b JOIN bet_legs l ON l.bet_id = b.id
    WHERE b.id = ${placed.betId}::uuid
  `);
  console.log(`  bet status: ${bet?.status}  locked leg odds: ${bet?.locked}`);

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("qa-place-bet failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
