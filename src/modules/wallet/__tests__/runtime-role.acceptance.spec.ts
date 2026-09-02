import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeWalletTestContexts,
  createWalletTestContext,
  type WalletTestContext,
} from "./helpers";

/**
 * What the runtime role must NOT be able to do.
 *
 * WHY THIS EXISTS
 * ---------------
 * A readiness check reported that all three configured production URLs connect
 * as `neondb_owner` — the role that owns the ledger tables. That was filed as a
 * note. It is not a note: it is the difference between "a compromised read
 * route leaks data" and "a compromised read route can drop the ledger".
 *
 * The money paths issue `SET LOCAL ROLE app_role` inside every transaction and
 * are safe. The pooled READ client does no role handling at all, and
 * thirty-four files import it — every board query, every admin page, every
 * public route.
 *
 * These tests assert the property that makes that survivable: as `app_role`,
 * PostgreSQL itself refuses the dangerous operations. They run through the
 * REAL runtime client against a real PostgreSQL, because a permission model is
 * only worth what the database actually enforces — not what a grant script
 * intended.
 *
 * SAFETY: every attempt is expected to FAIL, and each runs in its own
 * transaction that is rolled back regardless. Nothing here can succeed at
 * damaging anything; that is precisely what is being asserted. It never touches
 * a hosted database — the suite runs against a disposable embedded cluster.
 */

const ctx: WalletTestContext = createWalletTestContext();

afterAll(async () => {
  await closeWalletTestContexts([ctx]);
});

/**
 * Runs a statement as the runtime role and returns the error, if any.
 *
 * Always rolls back. A statement that unexpectedly SUCCEEDS is still undone,
 * so a failing assertion here reports a permission hole without also having
 * created one.
 */
async function attemptAsRuntimeRole(statement: string): Promise<string | null> {
  try {
    await ctx.database.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
      await tx.execute(sql.raw(statement));
      // Never keep it, even if the database allowed it.
      throw new Error("__rollback__");
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "__rollback__") return null; // it was permitted — a finding
    /*
     * Unwrap to PostgreSQL's own message.
     *
     * Drizzle wraps a driver error as "Failed query: <sql>", which says only
     * that something went wrong. Asserting against THAT would pass even if the
     * statement failed for a syntax error — so the test would claim a
     * permission was enforced when nothing of the sort had been proven. The
     * database's own wording is the evidence.
     */
    const causes: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      causes.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return causes.join(" | ");
  }
}

describe("the runtime role cannot damage the ledger", () => {
  it("is not the owner of the ledger tables", async () => {
    const rows = await ctx.database.execute<{ tablename: string; owner: string }>(sql`
      SELECT c.relname AS tablename, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname IN ('ledger_entries', 'ledger_transactions', 'wallets')
    `);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      // Ownership is what confers DROP and ALTER: PostgreSQL has no separate
      // privilege bit for either. So "not the owner" IS the guarantee.
      expect(row.owner).not.toBe("app_role");
    }
  });

  it("is refused DROP on a ledger table", async () => {
    const error = await attemptAsRuntimeRole("DROP TABLE ledger_entries");
    expect(error).not.toBeNull();
    expect(error).toMatch(/must be owner|permission denied/i);
  });

  it("is refused ALTER on a ledger table", async () => {
    const error = await attemptAsRuntimeRole(
      "ALTER TABLE ledger_entries ADD COLUMN injected_by_attacker text",
    );
    expect(error).not.toBeNull();
    expect(error).toMatch(/must be owner|permission denied/i);
  });

  it("is refused TRUNCATE on a ledger table", async () => {
    // The quietest way to destroy a ledger: no rows deleted one by one, no
    // trigger fired, just an empty table and a balanced sum of nothing.
    const error = await attemptAsRuntimeRole("TRUNCATE ledger_entries CASCADE");
    expect(error).not.toBeNull();
    expect(error).toMatch(/permission denied|must be owner/i);
  });

  it("is refused DELETE on ledger entries", async () => {
    // The ledger is append-only. Deleting a row would balance the books by
    // removing the evidence.
    const error = await attemptAsRuntimeRole("DELETE FROM ledger_entries");
    expect(error).not.toBeNull();
    expect(error).toMatch(/permission denied/i);
  });

  it("cannot disable the balance-enforcement trigger", async () => {
    /*
     * THE ONE THAT MATTERS MOST. Every other protection assumes the trigger
     * runs. A role that can switch it off can then write any balance it likes
     * through ordinary UPDATEs and leave the table looking consistent.
     */
    const error = await attemptAsRuntimeRole(
      "ALTER TABLE wallets DISABLE TRIGGER wallets_ledger_state_at_commit",
    );
    expect(error).not.toBeNull();
    expect(error).toMatch(/must be owner|permission denied/i);
  });

  it("cannot replace the trigger function with its own", async () => {
    const error = await attemptAsRuntimeRole(
      "CREATE OR REPLACE FUNCTION wallets_ledger_state_at_commit() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql",
    );
    expect(error).not.toBeNull();
    expect(error).toMatch(/must be owner|permission denied|already exists/i);
  });

  it("cannot actually widen its own privileges", async () => {
    /*
     * PostgreSQL does NOT raise an error here. `GRANT` by a role without grant
     * option emits a WARNING — "no privileges were granted" — and returns
     * successfully, which is why an earlier version of this test failed while
     * the system was behaving correctly.
     *
     * So the assertion has to be about the OUTCOME, not the error. Escalation
     * is the difference between a contained incident and a total one; what
     * matters is whether the grant took effect, not whether it complained.
     */
    const before = await ctx.database.execute<{ can_delete: boolean }>(sql`
      SELECT has_table_privilege('app_role', 'ledger_entries', 'DELETE') AS can_delete
    `);
    await attemptAsRuntimeRole("GRANT ALL ON ledger_entries TO app_role");
    const after = await ctx.database.execute<{ can_delete: boolean }>(sql`
      SELECT has_table_privilege('app_role', 'ledger_entries', 'DELETE') AS can_delete
    `);

    expect(before[0]!.can_delete).toBe(false);
    // Unchanged: the grant was a no-op, which is the property that matters.
    expect(after[0]!.can_delete).toBe(false);
  });

  it("cannot create a table in public to stage a swap", async () => {
    const error = await attemptAsRuntimeRole("CREATE TABLE attacker_staging (id int)");
    expect(error).not.toBeNull();
    expect(error).toMatch(/permission denied/i);
  });

  it("still has the privileges the application genuinely needs", async () => {
    // A permission model that breaks the app is not a permission model, it is
    // an outage. The runtime role must keep exactly what it uses.
    const [row] = await ctx.database.execute<{
      read_entries: boolean;
      write_entries: boolean;
      read_wallets: boolean;
      write_wallets: boolean;
    }>(sql`
      SELECT has_table_privilege('app_role', 'ledger_entries', 'SELECT') AS read_entries,
             has_table_privilege('app_role', 'ledger_entries', 'INSERT') AS write_entries,
             has_table_privilege('app_role', 'wallets', 'SELECT')        AS read_wallets,
             has_table_privilege('app_role', 'wallets', 'INSERT')        AS write_wallets
    `);
    expect(row!.read_entries).toBe(true);
    expect(row!.write_entries).toBe(true);
    expect(row!.read_wallets).toBe(true);
    expect(row!.write_wallets).toBe(true);
  });

  it("can update ONLY the wallet columns it is meant to", async () => {
    /*
     * The grant is COLUMN-level, and that is easy to lose by accident.
     *
     * `has_table_privilege(..., 'UPDATE')` is FALSE here — which surprised an
     * earlier version of this test into failing — because app_role holds
     * UPDATE on seven named columns rather than on the table. That is a
     * tighter grant than a table-level one, and worth pinning: widening it to
     * `GRANT UPDATE ON wallets` would let the runtime rewrite `user_id` and
     * move a balance between people, which no code path should ever do.
     */
    const [row] = await ctx.database.execute<{
      table_level: boolean;
      balance_col: boolean;
      version_col: boolean;
      user_id_col: boolean;
      kind_col: boolean;
    }>(sql`
      SELECT has_table_privilege('app_role', 'wallets', 'UPDATE')                        AS table_level,
             has_column_privilege('app_role', 'wallets', 'cached_balance_minor', 'UPDATE') AS balance_col,
             has_column_privilege('app_role', 'wallets', 'version', 'UPDATE')              AS version_col,
             has_column_privilege('app_role', 'wallets', 'user_id', 'UPDATE')              AS user_id_col,
             has_column_privilege('app_role', 'wallets', 'kind', 'UPDATE')                 AS kind_col
    `);

    // Not the whole table.
    expect(row!.table_level).toBe(false);
    // The columns the balance trigger and reconciliation actually write.
    expect(row!.balance_col).toBe(true);
    expect(row!.version_col).toBe(true);
    // And emphatically not the ones that decide WHOSE money it is.
    expect(row!.user_id_col).toBe(false);
    expect(row!.kind_col).toBe(false);
  });

  it("is not a superuser and does not bypass row-level security", async () => {
    const [row] = await ctx.database.execute<{ is_super: boolean; bypass: boolean }>(sql`
      SELECT COALESCE(rolsuper, false) AS is_super,
             COALESCE(rolbypassrls, false) AS bypass
      FROM pg_roles WHERE rolname = 'app_role'
    `);
    expect(row!.is_super).toBe(false);
    expect(row!.bypass).toBe(false);
  });
});
