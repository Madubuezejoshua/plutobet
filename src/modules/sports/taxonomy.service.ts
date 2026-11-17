import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";
import type { WalletTransaction } from "../wallet/types";
import {
  normalizeCompetitionKey,
  normalizeSportKey,
  normalizeTeamKey,
  parseCompetitionLabel,
} from "./canonical-name";

/**
 * Resolving provider strings to stable entities.
 *
 * Called on every sync, for every fixture, so the shape that matters is
 * "resolve or create, idempotently, under concurrency".
 *
 * THE CONCURRENCY POINT
 * Two sync workers can process the same new competition at the same instant.
 * The naive `SELECT then INSERT if missing` loses that race and one side gets
 * a unique-violation. Every resolver here uses `INSERT … ON CONFLICT DO
 * NOTHING` followed by a `SELECT`, so the loser of the race reads the winner's
 * row instead of failing. The unique indexes are what make that correct.
 *
 * THE THING THIS DOES NOT DO
 * It never merges two teams. If a spelling does not match an existing key or a
 * recorded alias, it creates a NEW team — deliberately, even though that
 * produces occasional duplicates. See canonical-name.ts: a duplicate is an
 * operator's afternoon, a wrong merge is two clubs' histories permanently
 * blended.
 */

export interface ResolvedFixture {
  sportId: string;
  competitionId: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
}

export class TaxonomyService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /**
   * Resolves a sport by its provider name.
   *
   * Unlike competitions and teams, an unknown sport is NOT created. The sports
   * list is a deliberate, seeded taxonomy with display ordering and an active
   * flag — letting a feed invent "Football (Women)" as a top-level sport would
   * corrupt the navigation the moment a provider changed a label.
   */
  async findSport(tx: WalletTransaction, providerSport: string): Promise<string | null> {
    const key = normalizeSportKey(providerSport);
    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM sports WHERE key = ${key}
    `);
    return row?.id ?? null;
  }

  /** Resolve-or-create a competition within a sport. */
  async resolveCompetition(
    tx: WalletTransaction,
    params: { sportId: string; label: string },
  ): Promise<string> {
    const parsed = parseCompetitionLabel(params.label);
    const key = normalizeCompetitionKey(parsed.name);

    // ON CONFLICT DO NOTHING then SELECT: the loser of a concurrent insert
    // reads the winner's row rather than raising a unique violation.
    await tx.execute(sql`
      INSERT INTO competitions (sport_id, key, name, country)
      VALUES (${params.sportId}::uuid, ${key}, ${parsed.name}, ${parsed.country})
      ON CONFLICT (sport_id, key) DO NOTHING
    `);

    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM competitions WHERE sport_id = ${params.sportId}::uuid AND key = ${key}
    `);
    if (!row) throw new Error(`competition ${key} could not be resolved`);
    return row.id;
  }

  /**
   * Resolve-or-create a team within a sport.
   *
   * Order of attempts, most trustworthy first:
   *   1. An explicit alias — somebody decided this.
   *   2. The conservative match key.
   *   3. Create a new team.
   *
   * Aliases are checked FIRST because they encode a human decision that
   * normalisation could not reach, and that decision should win.
   */
  async resolveTeam(
    tx: WalletTransaction,
    params: { sportId: string; name: string; country?: string | null },
  ): Promise<string> {
    const key = normalizeTeamKey(params.name);
    if (!key) throw new RangeError(`team name "${params.name}" normalises to nothing`);

    const [aliased] = await tx.execute<{ team_id: string }>(sql`
      SELECT team_id FROM team_aliases
      WHERE sport_id = ${params.sportId}::uuid AND alias_key = ${key}
    `);
    if (aliased) return aliased.team_id;

    await tx.execute(sql`
      INSERT INTO teams (sport_id, key, name, country)
      VALUES (${params.sportId}::uuid, ${key}, ${params.name}, ${params.country ?? null})
      ON CONFLICT (sport_id, key) DO NOTHING
    `);

    const [row] = await tx.execute<{ id: string }>(sql`
      SELECT id FROM teams WHERE sport_id = ${params.sportId}::uuid AND key = ${key}
    `);
    if (!row) throw new Error(`team ${key} could not be resolved`);
    return row.id;
  }

  /**
   * Resolves everything one fixture needs, in a single transaction.
   *
   * Returns nulls rather than throwing when a piece cannot be resolved. An
   * event whose competition is unrecognised must still be bettable: refusing a
   * bet on a real fixture because we could not classify it is a worse outcome
   * than an unclassified fixture, and the row can be backfilled.
   */
  async resolveFixture(params: {
    sport: string;
    league: string;
    home: string;
    away: string;
  }): Promise<ResolvedFixture | null> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const sportId = await this.findSport(tx, params.sport);
      if (!sportId) return null;

      const parsed = parseCompetitionLabel(params.league);

      const competitionId = await this.resolveCompetition(tx, {
        sportId,
        label: params.league,
      }).catch((error: unknown) => {
        console.error("[taxonomy] competition unresolved", params.league, error);
        return null;
      });

      const homeTeamId = await this.resolveTeam(tx, {
        sportId,
        name: params.home,
        country: parsed.country,
      }).catch((error: unknown) => {
        console.error("[taxonomy] home team unresolved", params.home, error);
        return null;
      });

      const awayTeamId = await this.resolveTeam(tx, {
        sportId,
        name: params.away,
        country: parsed.country,
      }).catch((error: unknown) => {
        console.error("[taxonomy] away team unresolved", params.away, error);
        return null;
      });

      return { sportId, competitionId, homeTeamId, awayTeamId };
    });
  }

  /**
   * Attaches resolved entities to an event row.
   *
   * A no-op when nothing resolved, so a provider format change degrades to
   * "unclassified fixtures" rather than failing the whole sync.
   */
  async classifyEvent(eventId: string, resolved: ResolvedFixture): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        UPDATE events SET
          sport_id       = ${resolved.sportId}::uuid,
          competition_id = COALESCE(${resolved.competitionId}::uuid, competition_id),
          home_team_id   = COALESCE(${resolved.homeTeamId}::uuid, home_team_id),
          away_team_id   = COALESCE(${resolved.awayTeamId}::uuid, away_team_id),
          updated_at     = now()
        WHERE id = ${eventId}::uuid
      `);
    });
  }

  /**
   * Records that a spelling means an existing team.
   *
   * The deliberate escape hatch from conservative matching — "Spurs" is
   * Tottenham, and no safe normaliser will ever work that out.
   *
   * Refuses to alias a spelling that is already a team's own key: that would
   * make one name resolve two ways depending on which lookup ran first, which
   * is exactly the non-determinism the unique indexes exist to prevent.
   */
  async addAlias(params: {
    sportId: string;
    teamId: string;
    alias: string;
    source?: string;
  }): Promise<void> {
    const aliasKey = normalizeTeamKey(params.alias);
    if (!aliasKey) throw new RangeError("alias normalises to nothing");

    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [clash] = await tx.execute<{ id: string }>(sql`
        SELECT id FROM teams
        WHERE sport_id = ${params.sportId}::uuid AND key = ${aliasKey}
          AND id <> ${params.teamId}::uuid
      `);
      if (clash) {
        throw new RangeError(
          `"${params.alias}" is already another team's own name; merge the teams instead`,
        );
      }

      await tx.execute(sql`
        INSERT INTO team_aliases (team_id, sport_id, alias_key, source)
        VALUES (
          ${params.teamId}::uuid, ${params.sportId}::uuid, ${aliasKey},
          ${params.source ?? "manual"}
        )
        ON CONFLICT (sport_id, alias_key) DO NOTHING
      `);
    });
  }
}

export const taxonomyService = new TaxonomyService();
