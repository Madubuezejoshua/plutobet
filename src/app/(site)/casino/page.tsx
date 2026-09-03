import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { CATEGORY_LABELS, catalogueService, type CasinoCategory } from "@/modules/casino/catalogue.service";
import { Dices } from "lucide-react";
import { PageShell } from "@/components/sportsbook/page-shell";

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
      <PageShell title="Casino" width="narrow">
        <section className="sb-panel" style={{ textAlign: "center", padding: "var(--sb-8) var(--sb-4)" }}>
          <Dices size={30} aria-hidden="true" style={{ color: "var(--sb-faint)" }} />
          <h2 style={{ margin: "var(--sb-3) 0 4px", fontSize: 19 }}>No games connected</h2>
          <p className="sb-muted" style={{ margin: 0 }}>
            The casino runs on a certified aggregator — we do not generate game outcomes
            ourselves, because a platform that does cannot prove it did so fairly.
          </p>
          <p className="sb-note sb-note--warn" style={{ display: "inline-flex", margin: "var(--sb-4) 0 0" }}>
            Awaiting an aggregator integration
          </p>
          <p className="sb-small sb-muted" style={{ maxWidth: 460, margin: "var(--sb-3) auto 0" }}>
            The lobby, sessions and wallet callbacks are built and tested. Games appear here the
            moment a provider catalogue is synced.
          </p>
          <div style={{ display: "flex", gap: "var(--sb-2)", justifyContent: "center", marginTop: "var(--sb-5)" }}>
            <Link href="/sports" className="sb-btn sb-btn--primary">Sports</Link>
            <Link href="/" className="sb-btn sb-btn--ghost">Home</Link>
          </div>
        </section>
      </PageShell>
    );
  }

  return (
    <PageShell title="Casino" sub={`${games.length} games`}>
      <div className="sb-panel" style={{ marginBottom: "var(--sb-3)" }}>
        <nav className="sb-chips" aria-label="Categories">
          <Link href="/casino" className="sb-chip" aria-current={valid ? undefined : "true"}>
            All
          </Link>
          {categories.map((entry) => (
            <Link
              key={entry.category}
              href={`/casino?category=${entry.category.toLowerCase()}`}
              className="sb-chip"
              aria-current={valid === entry.category ? "true" : undefined}
            >
              {CATEGORY_LABELS[entry.category]}
              <span className="sb-railitem__count">{entry.count}</span>
            </Link>
          ))}
        </nav>
      </div>

      {recent.length > 0 && !valid ? (
        <section className="sb-panel sb-pad" style={{ marginBottom: "var(--sb-3)" }}>
          <h2 className="sb-panel__title" style={{ marginBottom: "var(--sb-3)" }}>Recently played</h2>
          <div className="sb-cards">
            {recent.map((game) => (
              <span key={game.id} className="sb-card sb-card--inert">
                {game.name}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="sb-panel sb-pad">
        <h2 className="sb-panel__title" style={{ marginBottom: "var(--sb-3)" }}>
          {valid ? CATEGORY_LABELS[valid] : "All games"}
        </h2>
        <div className="sb-cards">
          {games.map((game) => (
            <span key={game.id} className="sb-card sb-card--inert">
              {game.name}
              {/* RTP is shown when the provider publishes it and omitted when
                  they do not. An invented figure on a gambling product is a
                  misrepresentation, not a nicer-looking card. */}
              {game.rtpPercent !== null ? (
                <span className="sb-card__meta">RTP {game.rtpPercent.toFixed(2)}%</span>
              ) : null}
            </span>
          ))}
        </div>
      </section>

      {/*
        The tiles do not launch.

        A game tile is normally a link to a launch route that mints a session
        token and hands the player to the aggregator. That route does not exist
        yet, and the only provider configured is the development sandbox, whose
        own `launchUrl` deliberately returns an explainer rather than a game.

        So the tiles are rendered as plain cards. Making them links would give
        every one of them a 404 behind it, which is the exact failure this
        product tries not to ship: a control that looks like it works.
      */}
      <p className="sb-note sb-note--warn" style={{ marginTop: "var(--sb-3)" }}>
        These games cannot be opened yet — no certified aggregator is connected, so there is
        nothing to launch. The catalogue is shown because it is real data from the provider
        integration, not a preview.
      </p>

      <p className="sb-xs sb-muted" style={{ marginTop: "var(--sb-3)" }}>
        Game outcomes are generated and certified by the provider, not by PlutoBet. Every stake
        and win moves through the same audited wallet as your sports bets.
      </p>
    </PageShell>
  );
}
