import Link from "next/link";

/**
 * Date and quick filters above the board.
 *
 * Real links with real query parameters, not client-side state that pretends
 * to filter. A filter the customer can bookmark and share is worth more than
 * one that resets on refresh, and it keeps the server the thing that decides
 * what is shown.
 */

export function DateStrip({
  active,
  sport,
  league,
  query,
}: {
  active: "today" | "all";
  sport: string;
  league?: string;
  query?: string;
}) {
  const base = (params: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    if (sport && sport !== "football") search.set("sport", sport);
    if (league) search.set("league", league);
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
    const query = search.toString();
    return query ? `/sports?${query}` : "/sports";
  };

  return (
    <div className="sb-panel" style={{ marginBottom: "var(--sb-3)" }}>
      <div className="sb-chips" role="group" aria-label="Filter fixtures">
        <Link href={base({})} className="sb-chip" aria-current={active === "all" ? "true" : undefined}>
          All upcoming
        </Link>
        <Link
          href={base({ when: "today" })}
          className="sb-chip"
          aria-current={active === "today" ? "true" : undefined}
        >
          Today
        </Link>
        <Link href="/live" className="sb-chip">Live now</Link>
        <Link href="/jackpot" className="sb-chip">Jackpot</Link>
        {league || query ? (
          <Link href="/sports" className="sb-chip" aria-label="Clear all filters">
            Clear filter
          </Link>
        ) : null}
      </div>
    </div>
  );
}
