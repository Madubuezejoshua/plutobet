import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { naira } from "@/lib/money";
import { guardAdminPage } from "../_guard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ledger" };

/**
 * Every money movement on the platform.
 *
 * The ledger is append-only and double-entry, so this page has no actions at
 * all — not even a hidden one. A correction is a new compensating transaction,
 * never an edit, and there is deliberately no code path from this screen to
 * one.
 *
 * Each transaction is shown with BOTH sides. Displaying a single entry would
 * be the more familiar "statement" view and would also be the one that lets a
 * reviewer believe money appeared from nowhere.
 */

type TxnRow = {
  id: string;
  type: string;
  created_at: Date;
  entry_count: number;
  total_minor: string;
  debit_accounts: string;
  credit_accounts: string;
  metadata: Record<string, unknown> | null;
}

export default async function AdminLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const guard = await guardAdminPage("ledger.read", "Ledger");
  if (!guard.ok) return guard.denied;

  const { type } = await searchParams;
  const filter = type?.toUpperCase() ?? null;

  const rows = await db.execute<TxnRow>(sql`
    SELECT
      t.id::text,
      t.type::text,
      t.created_at,
      t.metadata,
      count(e.id)::int AS entry_count,
      -- One side's total. In a balanced transaction debits equal credits, so
      -- either side is "the amount"; summing both would double it.
      COALESCE(sum(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT'), 0)::text AS total_minor,
      COALESCE(string_agg(DISTINCT w.kind::text, ', ')
        FILTER (WHERE e.direction = 'DEBIT'), '') AS debit_accounts,
      COALESCE(string_agg(DISTINCT w.kind::text, ', ')
        FILTER (WHERE e.direction = 'CREDIT'), '') AS credit_accounts
    FROM ledger_transactions t
    JOIN ledger_entries e ON e.txn_id = t.id
    JOIN wallets w ON w.id = e.wallet_id
    ${filter ? sql`WHERE t.type = ${filter}::ledger_txn_type` : sql``}
    GROUP BY t.id
    ORDER BY t.created_at DESC
    LIMIT 200
  `);

  const summary = await db.execute<{ type: string; n: number; total: string }>(sql`
    SELECT t.type::text, count(DISTINCT t.id)::int AS n,
           COALESCE(sum(e.amount_minor) FILTER (WHERE e.direction = 'DEBIT'), 0)::text AS total
    FROM ledger_transactions t
    JOIN ledger_entries e ON e.txn_id = t.id
    GROUP BY t.type
    ORDER BY 2 DESC
  `);

  return (
    <>
      <header className="page-head">
        <h1>Ledger</h1>
        <p className="muted">
          Append-only and double-entry. Corrections are posted as compensating
          transactions — nothing here can be edited, by anyone.
        </p>
      </header>

      <section className="tiles">
        {summary.map((row) => (
          <Link
            key={row.type}
            href={`/admin/ledger?type=${row.type}`}
            className={filter === row.type ? "tile active" : "tile"}
          >
            <span className="tile-label">{row.type.toLowerCase().replace(/_/g, " ")}</span>
            <span className="tile-value">{naira(BigInt(row.total))}</span>
            <span className="muted">{row.n} transactions</span>
          </Link>
        ))}
      </section>

      {filter ? (
        <p>
          <Link href="/admin/ledger" className="btn sm">
            Clear filter
          </Link>
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="notice">No ledger transactions yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="statement">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th className="right">Amount</th>
                <th>From</th>
                <th>To</th>
                <th>Entries</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((txn) => (
                <tr key={txn.id}>
                  <td className="muted">{new Date(txn.created_at).toLocaleString()}</td>
                  <td>{txn.type.toLowerCase().replace(/_/g, " ")}</td>
                  <td className="right">{naira(BigInt(txn.total_minor))}</td>
                  <td className="muted">{txn.debit_accounts || "—"}</td>
                  <td className="muted">{txn.credit_accounts || "—"}</td>
                  <td className="muted">
                    {txn.entry_count}
                    {/* A balanced transaction has an even number of entries.
                        An odd count would mean a trigger was bypassed, which
                        is a database-integrity emergency, not a display bug. */}
                    {txn.entry_count % 2 !== 0 ? (
                      <span className="pill critical"> unbalanced</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
