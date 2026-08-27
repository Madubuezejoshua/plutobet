import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { CATEGORY_LABELS, catalogueService, type CasinoCategory } from "@/modules/casino/catalogue.service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Casino" };

/**
 * The casino lobby.
 *
 * Lists only games that a real provider integration has synced. When no
 * provider is connected the page says so plainly rather than showing tiles
 * that lead nowhere — the same rule the rest of the product follows.
 */
export default async function CasinoPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const params = await searchParams;
  const session = await getServerSession(authOptions);

  const category = (params.category?.toUpperCase() as CasinoCategory | undefined) ?? undefined;
  const valid = category && category in CATEGORY_LABELS ? category : undefined;

  const [games, categories, recent] = await Promise.all([
    catalogueService.list({ category: valid }).catch(() => []),
    catalogueService.categoriesInUse().catch(() => []),
    session?.user
      ? catalogueService.recentlyPlayed(session.user.id).catch(() => [])
      : Promise.resolve([]),
  ]);

  if (categories.length === 0) {
    return (
      <>
        <header className="page-head">
          <h1>Casino</h1>
        </header>
        <section className="placeholder">
          <span className="ico" aria-hidden="true">🎰</span>
          <h2>No games connected</h2>
          <p>
            The casino runs on a certified aggregator — we do not generate game outcomes
            ourselves, because a platform that does cannot prove it did so fairly.
          </p>
          <span className="phase-tag">Awaiting an aggregator integration</span>
          <p className="small muted">
            The lobby, sessions and wallet callbacks are built and tested. Games appear here the
            moment a provider catalogue is synced.
          </p>
          <div className="placeholder-actions">
            <Link href="/sports" className="btn primary">Sports</Link>
            <Link href="/" className="btn ghost">Home</Link>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <header className="page-head">
        <h1>Casino</h1>
        <p className="muted">{games.length} games</p>
      </header>

      <nav className="chip-row" aria-label="Categories">
        <Link href="/casino" className="chip" aria-current={valid ? undefined : "page"}>
          All
        </Link>
        {categories.map((entry) => (
          <Link
            key={entry.category}
            href={`/casino?category=${entry.category.toLowerCase()}`}
            className="chip"
            aria-current={valid === entry.category ? "page" : undefined}
          >
            {CATEGORY_LABELS[entry.category]}
            <span className="chip-count">{entry.count}</span>
          </Link>
        ))}
      </nav>

      {recent.length > 0 && !valid ? (
        <section className="section">
          <div className="section-head"><h2>Recently played</h2></div>
          <div className="tile-row">
            {recent.map((game) => (
              <Link key={game.id} href={`/casino/play/${game.id}`} className="tile">
                <span className="ico" aria-hidden="true">🎲</span>
                {game.name}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>{valid ? CATEGORY_LABELS[valid] : "All games"}</h2>
        </div>
        <div className="tile-row">
          {games.map((game) => (
            <Link key={game.id} href={`/casino/play/${game.id}`} className="tile">
              <span className="ico" aria-hidden="true">🎲</span>
              {game.name}
              {/* RTP is shown when the provider publishes it and omitted when
                  they do not. An invented figure on a gambling product is a
                  misrepresentation, not a nicer-looking card. */}
              {game.rtpPercent !== null ? (
                <span className="muted small" style={{ fontWeight: 500 }}>
                  RTP {game.rtpPercent.toFixed(2)}%
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </section>

      <p className="muted small legal" style={{ marginBottom: 40 }}>
        Game outcomes are generated and certified by the provider, not by PlutoBet. Every stake
        and win moves through the same audited wallet as your sports bets.
      </p>
    </>
  );
}
