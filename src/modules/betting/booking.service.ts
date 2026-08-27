import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import {
  bookingCodeExpiry,
  generateBookingCode,
  isValidBookingCode,
  normalizeBookingCode,
} from "./booking-code";

/**
 * Saving and loading shared slips.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * Loading a booking code produces SELECTIONS. It never produces a bet, a
 * stake, or a price.
 *
 * The master build prompt is explicit that a booking code must not
 * automatically place a bet, and the reason is worth stating: the person
 * loading a code did not build the slip and has not agreed to anything. They
 * must see today's prices, choose their own stake, and confirm with their own
 * money. Anything less is placing a bet on someone's behalf.
 *
 * The table shape is what makes that structural — it has nowhere to put a
 * stake or a price, so no future change can quietly start honouring one.
 */

export class BookingCodeError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "EXPIRED" | "EMPTY_SLIP" | "TOO_MANY_LEGS" | "INVALID_CODE",
    message: string,
  ) {
    super(message);
    this.name = "BookingCodeError";
  }
}

/** Matches the placement service's own accumulator ceiling. */
const MAX_LEGS = 20;

export interface BookedSelection {
  selectionId: string;
  /** Everything below is resolved LIVE at load time, never stored. */
  eventId: string;
  fixture: string;
  marketKey: string;
  selectionLabel: string;
  /** Today's price. Null when the selection is no longer bettable. */
  currentPrice: number | null;
  available: boolean;
  startsAt: string;
}

export interface LoadedBookingCode {
  code: string;
  createdAt: Date;
  selections: BookedSelection[];
  /** True when at least one leg can no longer be backed. */
  hasUnavailable: boolean;
}

export class BookingService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Saves a slip and returns its code.
   *
   * Retries on collision rather than trusting one draw. The unique index is
   * what makes it correct; the retry is what stops a one-in-a-billion draw
   * from surfacing as an error to the customer.
   */
  async save(params: {
    userId?: string | null;
    selectionIds: string[];
  }): Promise<{ code: string; expiresAt: Date }> {
    const unique = [...new Set(params.selectionIds)];
    if (unique.length === 0) {
      throw new BookingCodeError("EMPTY_SLIP", "add a selection before booking");
    }
    if (unique.length > MAX_LEGS) {
      throw new BookingCodeError("TOO_MANY_LEGS", `a slip may hold at most ${MAX_LEGS} selections`);
    }

    const expiresAt = bookingCodeExpiry();

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      // Verify every selection exists before minting a code for it, so a code
      // never resolves to a slip that was never real.
      const found = await tx.execute<{ id: string }>(sql`
        SELECT id FROM selections
        WHERE id IN (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)})
      `);
      if (found.length !== unique.length) {
        throw new BookingCodeError("EMPTY_SLIP", "one or more selections no longer exist");
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = generateBookingCode();

        const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO booking_codes (code, created_by, expires_at)
          VALUES (${code}, ${params.userId ?? null}::uuid, ${expiresAt.toISOString()}::timestamptz)
          ON CONFLICT (code) DO NOTHING
          RETURNING id
        `);
        if (inserted.length === 0) continue; // astronomically unlikely; retry

        const bookingId = inserted[0]!.id;
        for (const [position, selectionId] of unique.entries()) {
          await tx.execute(sql`
            INSERT INTO booking_code_selections (booking_code_id, selection_id, position)
            VALUES (${bookingId}::uuid, ${selectionId}::uuid, ${position})
          `);
        }

        return { code, expiresAt };
      }

      throw new Error("could not allocate a booking code");
    });
  }

  /**
   * Loads a code and re-prices every leg against today's board.
   *
   * Returns unavailable legs rather than dropping them. Silently removing a
   * selection would hand the loader a slip quietly different from the one
   * they were sent, and they would have no way to know — far worse than
   * showing them what is no longer on.
   */
  async load(rawCode: string): Promise<LoadedBookingCode> {
    const code = normalizeBookingCode(rawCode);
    if (!isValidBookingCode(code)) {
      throw new BookingCodeError("INVALID_CODE", "that is not a valid booking code");
    }

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [booking] = await tx.execute<{
        id: string;
        code: string;
        created_at: Date;
        expires_at: Date;
      }>(sql`
        SELECT id, code, created_at, expires_at FROM booking_codes WHERE code = ${code}
      `);
      if (!booking) throw new BookingCodeError("NOT_FOUND", "no slip found for that code");

      if (new Date(booking.expires_at).getTime() <= Date.now()) {
        throw new BookingCodeError("EXPIRED", "that code has expired");
      }

      /*
       * The price comes from `selections` as it stands NOW, not from anything
       * recorded when the code was made — the row has nowhere to store a price
       * precisely so this cannot accidentally show a stale one.
       *
       * A leg counts as available only if the event has not started, the
       * market is open and the selection is open. Any one of those failing
       * means it cannot be backed.
       */
      const rows = await tx.execute<{
        selection_id: string;
        event_id: string;
        home: string;
        away: string;
        market_key: string;
        label: string;
        price: string;
        starts_at: Date;
        available: boolean;
      }>(sql`
        SELECT s.id AS selection_id, e.id AS event_id, e.home, e.away,
               m.key AS market_key, s.label,
               s.current_price_decimal::text AS price, e.starts_at,
               (m.status = 'OPEN' AND s.status = 'OPEN'
                AND e.status IN ('PENDING', 'LIVE')
                AND e.starts_at > now()) AS available
        FROM booking_code_selections bcs
        JOIN selections s   ON s.id = bcs.selection_id
        JOIN markets m      ON m.id = s.market_id
        JOIN events e       ON e.id = m.event_id
        WHERE bcs.booking_code_id = ${booking.id}::uuid
        ORDER BY bcs.position
      `);

      await tx.execute(sql`
        UPDATE booking_codes SET load_count = load_count + 1 WHERE id = ${booking.id}::uuid
      `);

      const selections: BookedSelection[] = rows.map((row) => ({
        selectionId: row.selection_id,
        eventId: row.event_id,
        fixture: `${row.home} v ${row.away}`,
        marketKey: row.market_key,
        selectionLabel: row.label,
        currentPrice: row.available ? Number(row.price) : null,
        available: row.available,
        startsAt: new Date(row.starts_at).toISOString(),
      }));

      return {
        code: booking.code,
        createdAt: new Date(booking.created_at),
        selections,
        hasUnavailable: selections.some((selection) => !selection.available),
      };
    });
  }
}

export const bookingService = new BookingService();
