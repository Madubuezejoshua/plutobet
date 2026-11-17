import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { CasinoProvider } from "./provider";

/**
 * The game catalogue.
 *
 * Reads go through the pooled client: browsing a lobby is the hottest read in
 * the casino product and never touches money. The sync writes through the
 * money client only because it shares that module's transaction helper, not
 * because it moves anything.
 */

export type CasinoCategory =
  | "SLOTS"
  | "TABLE"
  | "LIVE_CASINO"
  | "CRASH"
  | "INSTANT"
  | "JACKPOT";

export interface GameSummary {
  id: string;
  name: string;
  category: CasinoCategory;
  providerKey: string;
  providerName: string;
  thumbnailUrl: string | null;
  /** Percentage, to two places. Null when the provider does not publish it. */
  rtpPercent: number | null;
}

export const CATEGORY_LABELS: Record<CasinoCategory, string> = {
  SLOTS: "Slots",
  TABLE: "Table Games",
  LIVE_CASINO: "Live Casino",
  CRASH: "Crash",
  INSTANT: "Instant",
  JACKPOT: "Jackpots",
};

export class CatalogueService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Pulls a provider's catalogue into our own.
   *
   * Upserts rather than replacing: a game that disappears from a feed is
   * DEACTIVATED, never deleted, because `game_rounds` references it and a
   * deleted row would orphan somebody's history of real money staked.
   */
  async sync(provider: CasinoProvider): Promise<{ upserted: number; deactivated: number }> {
    const games = await provider.listGames();

    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO casino_providers (key, name, active)
        VALUES (${provider.key}, ${provider.name}, true)
        ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `);
      const providerId = row!.id;

      for (const [index, game] of games.entries()) {
        await tx.execute(sql`
          INSERT INTO casino_games (
            provider_id, provider_game_id, name, category,
            thumbnail_url, rtp_basis_points, display_order, active
          )
          VALUES (
            ${providerId}::uuid, ${game.providerGameId}, ${game.name},
            ${game.category}::casino_category, ${game.thumbnailUrl ?? null},
            ${game.rtpBasisPoints ?? null}, ${index}, true
          )
          ON CONFLICT (provider_id, provider_game_id) DO UPDATE SET
            name = EXCLUDED.name,
            category = EXCLUDED.category,
            thumbnail_url = EXCLUDED.thumbnail_url,
            rtp_basis_points = EXCLUDED.rtp_basis_points,
            display_order = EXCLUDED.display_order,
            active = true,
            updated_at = now()
        `);
      }

      const gone = await tx.execute<{ id: string }>(sql`
        UPDATE casino_games SET active = false, updated_at = now()
        WHERE provider_id = ${providerId}::uuid
          AND active = true
          AND provider_game_id <> ALL(${games.map((g) => g.providerGameId)}::text[])
        RETURNING id
      `);

      return { upserted: games.length, deactivated: gone.length };
    });
  }

  /** Active games, optionally in one category. */
  async list(opts?: { category?: CasinoCategory; limit?: number }): Promise<GameSummary[]> {
    const rows = await db.execute<{
      id: string;
      name: string;
      category: CasinoCategory;
      provider_key: string;
      provider_name: string;
      thumbnail_url: string | null;
      rtp_basis_points: number | null;
    }>(sql`
      SELECT g.id, g.name, g.category::text AS category,
             p.key AS provider_key, p.name AS provider_name,
             g.thumbnail_url, g.rtp_basis_points
      FROM casino_games g
      JOIN casino_providers p ON p.id = g.provider_id
      WHERE g.active = true AND p.active = true
        AND (${opts?.category ?? null}::text IS NULL
             OR g.category::text = ${opts?.category ?? null})
      ORDER BY g.display_order, g.name
      LIMIT ${Math.min(opts?.limit ?? 120, 300)}
    `);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      providerKey: row.provider_key,
      providerName: row.provider_name,
      thumbnailUrl: row.thumbnail_url,
      rtpPercent: row.rtp_basis_points === null ? null : Number(row.rtp_basis_points) / 100,
    }));
  }

  /** Categories that actually have something in them. */
  async categoriesInUse(): Promise<{ category: CasinoCategory; count: number }[]> {
    const rows = await db.execute<{ category: CasinoCategory; n: number }>(sql`
      SELECT g.category::text AS category, count(*)::int AS n
      FROM casino_games g
      JOIN casino_providers p ON p.id = g.provider_id
      WHERE g.active = true AND p.active = true
      GROUP BY g.category
      ORDER BY n DESC
    `);
    return rows.map((row) => ({ category: row.category, count: Number(row.n) }));
  }

  async recentlyPlayed(userId: string, limit = 8): Promise<GameSummary[]> {
    const rows = await db.execute<{
      id: string;
      name: string;
      category: CasinoCategory;
      provider_key: string;
      provider_name: string;
      thumbnail_url: string | null;
      rtp_basis_points: number | null;
    }>(sql`
      SELECT g.id, g.name, g.category::text AS category,
             p.key AS provider_key, p.name AS provider_name,
             g.thumbnail_url, g.rtp_basis_points
      FROM casino_recent_plays rp
      JOIN casino_games g ON g.id = rp.game_id
      JOIN casino_providers p ON p.id = g.provider_id
      WHERE rp.user_id = ${userId}::uuid AND g.active = true
      ORDER BY rp.last_played_at DESC
      LIMIT ${Math.min(limit, 20)}
    `);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      providerKey: row.provider_key,
      providerName: row.provider_name,
      thumbnailUrl: row.thumbnail_url,
      rtpPercent: row.rtp_basis_points === null ? null : Number(row.rtp_basis_points) / 100,
    }));
  }

  async recordPlay(userId: string, gameId: string): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO casino_recent_plays (user_id, game_id)
        VALUES (${userId}::uuid, ${gameId}::uuid)
        ON CONFLICT (user_id, game_id) DO UPDATE SET last_played_at = now()
      `);
    });
  }
}

export const catalogueService = new CatalogueService();
