import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeWalletTestContexts,
  createLedgerFundedWallet,
  createWalletTestContext,
  createZeroBalanceWallet,
  operationEvidence,
  replayWallet,
  testKey,
  walletSnapshot,
  type WalletTestContext,
} from "./helpers";

type DatabaseError = Error & {
  code?: string;
  constraint_name?: string;
};

async function expectSqlState(action: () => Promise<unknown>, sqlState: string): Promise<DatabaseError> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }

  expect(caught, `expected PostgreSQL SQLSTATE ${sqlState}`).toBeDefined();
  expect((caught as DatabaseError).code).toBe(sqlState);
  return caught as DatabaseError;
}

describe("ledger database invariants", () => {
  let context: WalletTestContext;

  beforeAll(() => {
    context = createWalletTestContext();
  });

  afterAll(async () => {
    await closeWalletTestContexts([context]);
  });

  it("rejects an unbalanced transaction at commit", async () => {
    const walletId = await createLedgerFundedWallet(context, 10_000n);
    const idempotencyKey = testKey("unbalanced");
    const fingerprint = "a".repeat(64);

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          const [systemWallet] = await tx<{ id: string }[]>`
            SELECT id FROM wallets
            WHERE kind = 'SYSTEM' AND system_account = 'STAKES_LIABILITY'
          `;
          if (!systemWallet) throw new Error("missing stakes system wallet");

          const [userWallet] = await tx<{
            cached_balance_minor: bigint;
            version: bigint;
          }[]>`
            SELECT cached_balance_minor, version
            FROM wallets
            WHERE id = ${walletId}
            FOR UPDATE
          `;
          if (!userWallet) throw new Error("missing funded user wallet");
          const nextBalance = userWallet.cached_balance_minor - 100n;
          const nextVersion = userWallet.version + 1n;

          const [header] = await tx<{ id: string }[]>`
            INSERT INTO ledger_transactions (
              type, idempotency_key, request_fingerprint, actor_type, metadata
            ) VALUES (
              'STAKE', ${idempotencyKey}, ${fingerprint}, 'SYSTEM', '{}'::jsonb
            )
            RETURNING id
          `;
          if (!header) throw new Error("header insert returned no id");

          await tx`
            INSERT INTO audit_log (
              actor_type, action, entity, entity_id, after
            ) VALUES (
              'SYSTEM', 'WALLET_DEBIT', 'WALLET', ${walletId},
              jsonb_build_object('transactionId', ${header.id}::text)
            )
          `;

          await tx`
            INSERT INTO ledger_entries (
              txn_id, wallet_id, direction, amount_minor,
              balance_after_minor, wallet_version
            ) VALUES
              (${header.id}, ${walletId}, 'DEBIT', 100, ${nextBalance}, ${nextVersion}),
              (${header.id}, ${systemWallet.id}, 'CREDIT', 50, NULL, NULL)
          `;

          // Keep the user-wallet cache/version consistent with its leg so the
          // deferred trigger reaches the intended aggregate-balance failure.
          await tx`
            UPDATE wallets
            SET cached_balance_minor = ${nextBalance},
                version = ${nextVersion},
                updated_at = now()
            WHERE id = ${walletId}
          `;
        }),
      "23514",
    );

    expect(error.constraint_name).toBe("ledger_transaction_balanced");
    expect((await operationEvidence(context, idempotencyKey)).transactions).toBe(0);
    const snapshot = await walletSnapshot(context, walletId);
    expect(snapshot.cachedBalanceMinor).toBe(10_000n);
    expect(snapshot.version).toBe(1n);
  });

  it("rejects a balanced ledger transaction without its matching wallet cache update", async () => {
    const walletId = await createZeroBalanceWallet(context);
    const idempotencyKey = testKey("missing-cache-update");
    const fingerprint = "f".repeat(64);

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          const [systemWallet] = await tx<{ id: string }[]>`
            SELECT id FROM wallets
            WHERE kind = 'SYSTEM' AND system_account = 'CASH_IN'
          `;
          if (!systemWallet) throw new Error("missing cash-in system wallet");

          const [header] = await tx<{ id: string }[]>`
            INSERT INTO ledger_transactions (
              type, idempotency_key, request_fingerprint, actor_type, metadata
            ) VALUES (
              'DEPOSIT', ${idempotencyKey}, ${fingerprint}, 'SYSTEM', '{}'::jsonb
            )
            RETURNING id
          `;
          if (!header) throw new Error("header insert returned no id");

          await tx`
            INSERT INTO audit_log (
              actor_type, action, entity, entity_id, after
            ) VALUES (
              'SYSTEM', 'WALLET_CREDIT', 'WALLET', ${walletId},
              jsonb_build_object('transactionId', ${header.id}::text)
            )
          `;

          // Both legs are valid at insertion time and balance as a group. The
          // omitted cache/version UPDATE is therefore the only deferred fault.
          await tx`
            INSERT INTO ledger_entries (
              txn_id, wallet_id, direction, amount_minor,
              balance_after_minor, wallet_version
            ) VALUES
              (${header.id}, ${walletId}, 'CREDIT', 100, 100, 1),
              (${header.id}, ${systemWallet.id}, 'DEBIT', 100, NULL, NULL)
          `;
        }),
      "23514",
    );

    expect(error.message).toMatch(
      /wallet .* cache\/version was not committed with ledger transaction/i,
    );
    expect(error.constraint_name).toBe("ledger_entries_cache_committed");
    expect((await operationEvidence(context, idempotencyKey)).transactions).toBe(0);
    const snapshot = await walletSnapshot(context, walletId);
    expect(snapshot.cachedBalanceMinor).toBe(0n);
    expect(snapshot.version).toBe(0n);
  });

  it("rejects an otherwise valid ledger transaction without same-transaction audit evidence", async () => {
    const walletId = await createZeroBalanceWallet(context);
    const idempotencyKey = testKey("missing-audit");
    const fingerprint = "9".repeat(64);

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          const [systemWallet] = await tx<{ id: string }[]>`
            SELECT id FROM wallets
            WHERE kind = 'SYSTEM' AND system_account = 'CASH_IN'
          `;
          if (!systemWallet) throw new Error("missing cash-in system wallet");

          const [header] = await tx<{ id: string }[]>`
            INSERT INTO ledger_transactions (
              type, idempotency_key, request_fingerprint, actor_type, metadata
            ) VALUES (
              'DEPOSIT', ${idempotencyKey}, ${fingerprint}, 'SYSTEM', '{}'::jsonb
            )
            RETURNING id
          `;
          if (!header) throw new Error("header insert returned no id");

          await tx`
            INSERT INTO ledger_entries (
              txn_id, wallet_id, direction, amount_minor,
              balance_after_minor, wallet_version
            ) VALUES
              (${header.id}, ${walletId}, 'CREDIT', 100, 100, 1),
              (${header.id}, ${systemWallet.id}, 'DEBIT', 100, NULL, NULL)
          `;
          await tx`
            UPDATE wallets
            SET cached_balance_minor = 100,
                version = 1,
                updated_at = now()
            WHERE id = ${walletId}
          `;
        }),
      "23514",
    );

    expect(error.message).toMatch(
      /ledger transaction .* has no matching same-transaction audit evidence/i,
    );
    expect(error.constraint_name).toBe("ledger_transaction_audit_required");
    expect((await operationEvidence(context, idempotencyKey)).transactions).toBe(0);
    const snapshot = await walletSnapshot(context, walletId);
    expect(snapshot.cachedBalanceMinor).toBe(0n);
    expect(snapshot.version).toBe(0n);
  });

  it.each([
    {
      malformedField: "balance_after_minor",
      balanceAfterMinor: 101n,
      walletVersion: 1n,
    },
    {
      malformedField: "wallet_version",
      balanceAfterMinor: 100n,
      walletVersion: 2n,
    },
  ])(
    "rejects malformed user-wallet $malformedField before deferred balance checks",
    async ({ balanceAfterMinor, walletVersion }) => {
      const walletId = await createZeroBalanceWallet(context);
      const idempotencyKey = testKey("malformed-user-leg");
      const fingerprint = "c".repeat(64);

      const error = await expectSqlState(
        () =>
          context.sql.begin(async (tx) => {
            await tx`SET LOCAL ROLE app_role`;
            const [header] = await tx<{ id: string }[]>`
              INSERT INTO ledger_transactions (
                type, idempotency_key, request_fingerprint, actor_type, metadata
              ) VALUES (
                'DEPOSIT', ${idempotencyKey}, ${fingerprint}, 'SYSTEM', '{}'::jsonb
              )
              RETURNING id
            `;
            if (!header) throw new Error("header insert returned no id");

            await tx`
              INSERT INTO ledger_entries (
                txn_id, wallet_id, direction, amount_minor,
                balance_after_minor, wallet_version
              ) VALUES (
                ${header.id}, ${walletId}, 'CREDIT', 100,
                ${balanceAfterMinor}, ${walletVersion}
              )
            `;
          }),
        "23514",
      );

      expect(error.message).toMatch(/ledger leg does not match locked wallet/i);
      expect(error.constraint_name).toBe("ledger_entries_user_state_valid");
      expect((await operationEvidence(context, idempotencyKey)).transactions).toBe(0);
      const snapshot = await walletSnapshot(context, walletId);
      expect(snapshot.cachedBalanceMinor).toBe(0n);
      expect(snapshot.version).toBe(0n);
    },
  );

  it("requires replay state on every user-wallet ledger leg", async () => {
    const walletId = await createZeroBalanceWallet(context);
    const idempotencyKey = testKey("missing-user-leg-state");
    const fingerprint = "d".repeat(64);

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          const [header] = await tx<{ id: string }[]>`
            INSERT INTO ledger_transactions (
              type, idempotency_key, request_fingerprint, actor_type, metadata
            ) VALUES (
              'DEPOSIT', ${idempotencyKey}, ${fingerprint}, 'SYSTEM', '{}'::jsonb
            )
            RETURNING id
          `;
          if (!header) throw new Error("header insert returned no id");

          await tx`
            INSERT INTO ledger_entries (
              txn_id, wallet_id, direction, amount_minor,
              balance_after_minor, wallet_version
            ) VALUES (
              ${header.id}, ${walletId}, 'CREDIT', 100, NULL, NULL
            )
          `;
        }),
      "23514",
    );

    expect(error.message).toMatch(
      /user-wallet ledger legs require balance_after_minor and wallet_version/i,
    );
    expect(error.constraint_name).toBe("ledger_entries_user_state_required");
    expect((await operationEvidence(context, idempotencyKey)).transactions).toBe(0);
  });

  it("forbids cached replay state on system-wallet ledger legs", async () => {
    const idempotencyKey = testKey("system-leg-state");
    const fingerprint = "e".repeat(64);

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          const [systemWallet] = await tx<{ id: string }[]>`
            SELECT id FROM wallets
            WHERE kind = 'SYSTEM' AND system_account = 'CASH_IN'
          `;
          if (!systemWallet) throw new Error("missing cash-in system wallet");

          const [header] = await tx<{ id: string }[]>`
            INSERT INTO ledger_transactions (
              type, idempotency_key, request_fingerprint, actor_type, metadata
            ) VALUES (
              'DEPOSIT', ${idempotencyKey}, ${fingerprint}, 'SYSTEM', '{}'::jsonb
            )
            RETURNING id
          `;
          if (!header) throw new Error("header insert returned no id");

          await tx`
            INSERT INTO ledger_entries (
              txn_id, wallet_id, direction, amount_minor,
              balance_after_minor, wallet_version
            ) VALUES (
              ${header.id}, ${systemWallet.id}, 'DEBIT', 100, 0, 1
            )
          `;
        }),
      "23514",
    );

    expect(error.message).toMatch(
      /system-wallet ledger legs cannot carry cached balance state/i,
    );
    expect(error.constraint_name).toBe("ledger_entries_system_state_forbidden");
    expect((await operationEvidence(context, idempotencyKey)).transactions).toBe(0);
  });

  it("rejects appending a new leg to a committed ledger header", async () => {
    const walletId = await createZeroBalanceWallet(context);
    const idempotencyKey = testKey("sealed-header");
    const result = await context.wallet.credit({
      walletId,
      amountMinor: 1_000n,
      type: "DEPOSIT",
      idempotencyKey,
      actor: { type: "SYSTEM" },
    });

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          await tx`
            INSERT INTO ledger_entries (
              txn_id, wallet_id, direction, amount_minor,
              balance_after_minor, wallet_version
            ) VALUES (
              ${result.transactionId}, ${walletId}, 'DEBIT', 100, 900, 2
            )
          `;
        }),
      "55000",
    );

    expect(error.message).toMatch(/ledger transaction .* is sealed/i);
    expect(error.constraint_name).toBe("ledger_entries_header_sealed");
    expect(await operationEvidence(context, idempotencyKey)).toEqual({
      transactions: 1,
      transactionId: result.transactionId,
      legs: 2,
      audits: 1,
    });
    const snapshot = await walletSnapshot(context, walletId);
    expect(snapshot.cachedBalanceMinor).toBe(1_000n);
    expect(snapshot.version).toBe(1n);
  });

  it("rejects a ledger transaction header committed with zero legs", async () => {
    const walletId = await createZeroBalanceWallet(context);
    const idempotencyKey = testKey("empty-header");
    const fingerprint = "b".repeat(64);

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          const [header] = await tx<{ id: string }[]>`
            INSERT INTO ledger_transactions (
              type, idempotency_key, request_fingerprint, actor_type, metadata
            ) VALUES (
              'ADJUSTMENT', ${idempotencyKey}, ${fingerprint}, 'SYSTEM', '{}'::jsonb
            )
            RETURNING id
          `;
          if (!header) throw new Error("header insert returned no id");

          await tx`
            INSERT INTO audit_log (
              actor_type, action, entity, entity_id, after
            ) VALUES (
              'SYSTEM', 'WALLET_CREDIT', 'WALLET', ${walletId},
              jsonb_build_object('transactionId', ${header.id}::text)
            )
          `;
        }),
      "23514",
    );

    expect(error.constraint_name).toBe("ledger_transaction_balanced");
    expect((await operationEvidence(context, idempotencyKey)).transactions).toBe(0);
  });

  it("rejects a direct negative cached balance", async () => {
    const walletId = await createLedgerFundedWallet(context, 1_000n);

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          await tx`UPDATE wallets SET cached_balance_minor = -1 WHERE id = ${walletId}`;
        }),
      "23514",
    );

    expect(error.constraint_name).toBe("wallets_cached_balance_nonnegative");
    expect(await context.wallet.getBalance(walletId)).toBe(1_000n);
    expect(await replayWallet(context, walletId)).toBe(1_000n);
  });

  it("rejects standalone positive wallet cache/version tampering", async () => {
    const walletId = await createLedgerFundedWallet(context, 1_000n);

    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          await tx`
            UPDATE wallets
            SET cached_balance_minor = 1_100,
                version = version + 1,
                updated_at = now()
            WHERE id = ${walletId}
          `;
        }),
      "23514",
    );

    expect(error.message).toMatch(
      /wallet .* cache\/version update has no matching same-transaction ledger leg/i,
    );
    expect(error.constraint_name).toBe("wallets_ledger_state_committed");
    expect(await context.wallet.getBalance(walletId)).toBe(1_000n);
    expect(await replayWallet(context, walletId)).toBe(1_000n);
    const snapshot = await walletSnapshot(context, walletId);
    expect(snapshot.version).toBe(1n);
  });

  it("rejects spoofed audit creation transaction ids", async () => {
    const error = await expectSqlState(
      () =>
        context.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE app_role`;
          await tx`
            INSERT INTO audit_log (
              actor_type, action, entity, entity_id,
              creation_transaction_id, after
            ) VALUES (
              'SYSTEM', 'TEST_AUDIT_SPOOF', 'TEST', 'audit-spoof', -1, '{}'::jsonb
            )
          `;
        }),
      "55000",
    );

    expect(error.message).toMatch(/audit evidence must identify its creating transaction/i);
    expect(error.constraint_name).toBe("audit_log_creation_transaction_current");
  });

  it("denies app_role UPDATE, DELETE, and TRUNCATE on immutable tables", async () => {
    const statements = [
      "UPDATE ledger_transactions SET metadata = metadata WHERE false",
      "DELETE FROM ledger_transactions WHERE false",
      "TRUNCATE TABLE ledger_transactions",
      "UPDATE ledger_entries SET amount_minor = amount_minor WHERE false",
      "DELETE FROM ledger_entries WHERE false",
      "TRUNCATE TABLE ledger_entries",
      "UPDATE audit_log SET action = action WHERE false",
      "DELETE FROM audit_log WHERE false",
      "TRUNCATE TABLE audit_log",
    ];

    for (const statement of statements) {
      await expectSqlState(
        () =>
          context.sql.begin(async (tx) => {
            await tx`SET LOCAL ROLE app_role`;
            await tx.unsafe(statement);
          }),
        "42501",
      );
    }
  });

  it("rolls ledger, cache, and audit back together when the audit append fails", async () => {
    const walletId = await createZeroBalanceWallet(context);
    const idempotencyKey = testKey("audit-rollback");

    await expect(
      context.wallet.credit({
        walletId,
        amountMinor: 5_000n,
        type: "DEPOSIT",
        idempotencyKey,
        actor: { type: "SYSTEM", ip: "definitely-not-an-ip-address" },
      }),
    ).rejects.toBeDefined();

    expect(await context.wallet.getBalance(walletId)).toBe(0n);
    expect(await replayWallet(context, walletId)).toBe(0n);
    expect(await operationEvidence(context, idempotencyKey)).toEqual({
      transactions: 0,
      transactionId: null,
      legs: 0,
      audits: 0,
    });
    const snapshot = await walletSnapshot(context, walletId);
    expect(snapshot.cachedBalanceMinor).toBe(0n);
    expect(snapshot.version).toBe(0n);
  });
});
