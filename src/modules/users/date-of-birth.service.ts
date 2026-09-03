import { sql } from "drizzle-orm";
import { appendAuditLog } from "../audit/append";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import { assertOldEnough } from "./age";

/**
 * Completing a date of birth that was never recorded.
 *
 * WHY THESE ACCOUNTS EXIST. `users.date_of_birth` is nullable, and accounts
 * created before it was collected have no value. The database trigger
 * `users_minimum_age` only fires when the column is NOT NULL, so those accounts
 * sit outside the age control entirely — not underage, but unverified, which is
 * the same thing to a regulator asking how you know.
 *
 * WHAT THIS IS NOT. It does not invent, infer or default a date. There is no
 * safe way to guess one, and a fabricated date of birth on a gambling account is
 * worse than a missing one: it converts "we do not know" into a false record
 * that looks like diligence. The customer supplies it or the account stays
 * restricted.
 *
 * WHY THE COLUMN IS STILL NULLABLE. `NOT NULL` is the end state and cannot be
 * applied while any row is NULL — the migration would fail, and forcing it
 * through would mean writing a placeholder date, which is the exact thing above.
 * The procedure for tightening it is at the bottom of this file.
 */

export class DateOfBirthAlreadySetError extends Error {
  constructor() {
    // Deliberately not "you already told us it was X": this message can reach a
    // log, and the value is personal data.
    super("this account already has a date of birth on file");
    this.name = "DateOfBirthAlreadySetError";
  }
}

export class DateOfBirthService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Does this account still owe us a date of birth?
   *
   * Read on the money and wagering paths, so it is a single indexed lookup by
   * primary key rather than anything cleverer.
   */
  async isMissing(userId: string): Promise<boolean> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => this.isMissingWithin(tx, userId));
  }

  /**
   * The same question inside a caller's transaction.
   *
   * The gates on placement and withdrawal use this so the check and the money
   * movement share one transaction: a date supplied concurrently either lands
   * before this read or after the whole request, never in the middle of it.
   */
  async isMissingWithin(tx: WalletTransaction, userId: string): Promise<boolean> {
    const [row] = await tx.execute<{ missing: boolean }>(sql`
      SELECT (date_of_birth IS NULL) AS missing FROM users WHERE id = ${userId}::uuid
    `);
    // An unknown user is not "missing a date of birth" — it is a different
    // failure, and the caller's own account check reports it properly.
    return row?.missing === true;
  }

  /**
   * Records a date of birth the customer supplied.
   *
   * Refuses if one is already on file. A date of birth is not a preference: it
   * is the fact the age gate rests on, and letting it be edited would turn a
   * refused registration into an accepted one on the second attempt. Correcting
   * a genuine mistake is an admin action with a reason attached, not a
   * self-service field.
   *
   * `assertOldEnough` rejects a malformed date, a date that does not exist
   * (2026-02-30, which `Date` silently rolls forward), a future date, an
   * implausible year, and anyone under 18. The database trigger then refuses it
   * again on write — the control that actually counts, because it holds against
   * a bug here.
   */
  async complete(params: {
    userId: string;
    dateOfBirth: string;
    ip: string;
  }): Promise<{ dateOfBirth: string }> {
    const validated = assertOldEnough(params.dateOfBirth);

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      /*
       * Locked, so two submissions cannot both see a NULL and both write. The
       * second would otherwise silently overwrite the first, which is how a
       * date of birth becomes editable by accident.
       */
      const [locked] = await tx.execute<{ existing: string | null }>(sql`
        SELECT date_of_birth::text AS existing FROM users
        WHERE id = ${params.userId}::uuid
        FOR UPDATE
      `);
      if (!locked) throw new Error(`unknown user ${params.userId}`);
      if (locked.existing !== null) throw new DateOfBirthAlreadySetError();

      await tx.execute(sql`
        UPDATE users SET date_of_birth = ${validated}::date, updated_at = now()
        WHERE id = ${params.userId}::uuid
      `);

      /*
       * The audit row records THAT a date was supplied and by whom, not what it
       * was. The value is personal data and already lives in the column; a
       * second copy in an append-only log is a second thing to protect for no
       * extra evidence.
       */
      await appendAuditLog(tx, {
        actorType: "USER",
        actorId: params.userId,
        action: "DATE_OF_BIRTH_COMPLETED",
        entity: "user",
        entityId: params.userId,
        before: { dateOfBirth: null },
        after: { dateOfBirth: "SET" },
        ip: params.ip,
      });

      return { dateOfBirth: validated };
    });
  }
}

export const dateOfBirthService = new DateOfBirthService();

/**
 * TIGHTENING THE COLUMN TO `NOT NULL` — the procedure, for whoever does it.
 *
 * Not done here, and deliberately. The migration fails while any row is NULL,
 * and the only ways to make it pass are to obtain every missing date or to
 * delete the accounts. Both are owner decisions with customers attached.
 *
 *   1. Read the outstanding count. It is on the admin compliance page, and:
 *        SELECT count(*) FROM users WHERE date_of_birth IS NULL;
 *
 *   2. Let the completion flow drain it. Every affected customer is asked at
 *      their next authenticated session and cannot bet, deposit or withdraw
 *      until they answer, so the number falls on its own.
 *
 *   3. Decide what happens to accounts that never come back. An account that
 *      cannot be age-verified cannot be allowed to gamble; closing or
 *      permanently restricting it is a compliance decision, not a code change.
 *
 *   4. When the count is zero, add a migration:
 *        ALTER TABLE "users" ALTER COLUMN "date_of_birth" SET NOT NULL;
 *      and delete `isMissing`, the gates that call it, and this note.
 *
 * Until step 4, enforcement is structural for new accounts (registration and
 * the trigger) and procedural for old ones (the gates below). Saying otherwise
 * would overstate the control.
 */
