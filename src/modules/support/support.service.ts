import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Support tickets and disputes.
 *
 * WHAT THIS DELIBERATELY CANNOT DO
 * Move money, settle a bet, or change an account's status. A ticket records a
 * conversation and a decision; acting on that decision goes through the
 * ordinary money paths with their own permissions and audit trail.
 *
 * The alternative — letting an agent resolve a dispute by adjusting a balance
 * from the ticket screen — is a support desk with a payout button, and it is
 * the exact shape of both the honest mistake and the dishonest one.
 */

export type TicketCategory =
  | "ACCOUNT"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "BET_DISPUTE"
  | "VERIFICATION"
  | "RESPONSIBLE_GAMBLING"
  | "OTHER";

export type TicketStatus = "OPEN" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED";

export class SupportError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "NOT_YOURS" | "CLOSED" | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SupportError";
  }
}

export interface TicketSummary {
  id: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketMessage {
  id: string;
  fromStaff: boolean;
  body: string;
  createdAt: Date;
}

export class SupportService {
  constructor(private readonly wallet: WalletService = walletService) {}

  async open(params: {
    userId: string;
    category: TicketCategory;
    subject: string;
    body: string;
    disputedEntity?: "bet" | "withdrawal" | "payment_intent" | "game_round";
    disputedEntityId?: string;
  }): Promise<{ ticketId: string }> {
    const subject = params.subject.trim();
    const body = params.body.trim();

    if (subject.length < 3 || subject.length > 200) {
      throw new SupportError("INVALID", "give the ticket a short subject");
    }
    if (body.length < 1 || body.length > 5000) {
      throw new SupportError("INVALID", "describe the problem");
    }
    // Both halves of the reference or neither: a dangling id nobody can
    // resolve is worse than no reference.
    if (Boolean(params.disputedEntity) !== Boolean(params.disputedEntityId)) {
      throw new SupportError("INVALID", "a dispute needs both what is disputed and its id");
    }

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      /*
       * A dispute must reference something the customer actually owns.
       *
       * Without this, a ticket could name any bet id and an agent reviewing it
       * would be looking at a stranger's wager while reading this customer's
       * complaint.
       */
      if (params.disputedEntity === "bet" && params.disputedEntityId) {
        const [bet] = await tx.execute<{ id: string }>(sql`
          SELECT id FROM bets
          WHERE id = ${params.disputedEntityId}::uuid AND user_id = ${params.userId}::uuid
        `);
        if (!bet) throw new SupportError("NOT_YOURS", "that bet is not on your account");
      }
      if (params.disputedEntity === "withdrawal" && params.disputedEntityId) {
        const [withdrawal] = await tx.execute<{ id: string }>(sql`
          SELECT id FROM withdrawals
          WHERE id = ${params.disputedEntityId}::uuid AND user_id = ${params.userId}::uuid
        `);
        if (!withdrawal) {
          throw new SupportError("NOT_YOURS", "that withdrawal is not on your account");
        }
      }

      const [ticket] = await tx.execute<{ id: string }>(sql`
        INSERT INTO support_tickets (user_id, category, subject, disputed_entity, disputed_entity_id)
        VALUES (
          ${params.userId}::uuid, ${params.category}::ticket_category, ${subject},
          ${params.disputedEntity ?? null}, ${params.disputedEntityId ?? null}::uuid
        )
        RETURNING id
      `);
      if (!ticket) throw new Error("ticket insert returned no row");

      await tx.execute(sql`
        INSERT INTO support_messages (ticket_id, author_id, from_staff, body)
        VALUES (${ticket.id}::uuid, ${params.userId}::uuid, false, ${body})
      `);

      return { ticketId: ticket.id };
    });
  }

  /** Adds a message. Scoped by owner in the WHERE clause, not checked first. */
  async reply(params: {
    ticketId: string;
    authorId: string;
    body: string;
    fromStaff: boolean;
    internal?: boolean;
  }): Promise<void> {
    const body = params.body.trim();
    if (body.length < 1 || body.length > 5000) {
      throw new SupportError("INVALID", "the message is empty");
    }

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [ticket] = await tx.execute<{ id: string; status: string; user_id: string }>(sql`
        SELECT id, status::text AS status, user_id FROM support_tickets
        WHERE id = ${params.ticketId}::uuid
      `);
      if (!ticket) throw new SupportError("NOT_FOUND", "no such ticket");

      // A customer may only reply to their own; staff may reply to any.
      if (!params.fromStaff && ticket.user_id !== params.authorId) {
        throw new SupportError("NOT_YOURS", "that ticket is not yours");
      }
      if (ticket.status === "CLOSED") {
        throw new SupportError("CLOSED", "this ticket is closed; open a new one");
      }

      await tx.execute(sql`
        INSERT INTO support_messages (ticket_id, author_id, from_staff, body, internal)
        VALUES (
          ${params.ticketId}::uuid, ${params.authorId}::uuid,
          ${params.fromStaff}, ${body}, ${params.internal ?? false}
        )
      `);

      // A customer replying reopens the ticket; staff replying puts the ball
      // back in the customer's court. Neither ever closes it silently.
      await tx.execute(sql`
        UPDATE support_tickets
        SET status = ${params.fromStaff ? "WAITING_CUSTOMER" : "OPEN"}::ticket_status,
            updated_at = now()
        WHERE id = ${params.ticketId}::uuid AND status <> 'CLOSED'
      `);
    });
  }

  /** A customer's own tickets. */
  async listFor(userId: string): Promise<TicketSummary[]> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        category: TicketCategory;
        subject: string;
        status: TicketStatus;
        message_count: number;
        created_at: Date;
        updated_at: Date;
      }>(sql`
        SELECT t.id, t.category::text AS category, t.subject, t.status::text AS status,
               count(m.id) FILTER (WHERE m.internal = false)::int AS message_count,
               t.created_at, t.updated_at
        FROM support_tickets t
        LEFT JOIN support_messages m ON m.ticket_id = t.id
        WHERE t.user_id = ${userId}::uuid
        GROUP BY t.id
        ORDER BY t.updated_at DESC
        LIMIT 50
      `);

      return rows.map((row) => ({
        id: row.id,
        category: row.category,
        subject: row.subject,
        status: row.status,
        messageCount: Number(row.message_count),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));
    });
  }

  /**
   * One ticket's conversation.
   *
   * `includeInternal` is false for a customer, so staff notes never reach them.
   * Filtered in SQL rather than after the fetch: a note that was loaded and
   * then dropped by a render is one refactor away from being displayed.
   */
  async messages(
    ticketId: string,
    opts: { userId?: string; includeInternal: boolean },
  ): Promise<TicketMessage[]> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const rows = await tx.execute<{
        id: string;
        from_staff: boolean;
        body: string;
        created_at: Date;
      }>(sql`
        SELECT m.id, m.from_staff, m.body, m.created_at
        FROM support_messages m
        JOIN support_tickets t ON t.id = m.ticket_id
        WHERE m.ticket_id = ${ticketId}::uuid
          AND (${opts.includeInternal} OR m.internal = false)
          AND (${opts.userId ?? null}::uuid IS NULL OR t.user_id = ${opts.userId ?? null}::uuid)
        ORDER BY m.created_at ASC
      `);

      return rows.map((row) => ({
        id: row.id,
        fromStaff: row.from_staff,
        body: row.body,
        createdAt: new Date(row.created_at),
      }));
    });
  }

  /**
   * Records a decision.
   *
   * Requires a resolution note, enforced by the database as well: a ticket
   * closed with no explanation cannot be reviewed later, which is exactly when
   * somebody asks why.
   */
  async resolve(params: {
    ticketId: string;
    staffId: string;
    resolution: string;
    close: boolean;
  }): Promise<void> {
    const resolution = params.resolution.trim();
    if (resolution.length < 3) {
      throw new SupportError("INVALID", "a resolution note is required");
    }

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE support_tickets
        SET status = ${params.close ? "CLOSED" : "RESOLVED"}::ticket_status,
            resolution = ${resolution},
            assigned_to = ${params.staffId}::uuid,
            resolved_at = now(),
            updated_at = now()
        WHERE id = ${params.ticketId}::uuid
      `);
    });
  }
}

export const supportService = new SupportService();
