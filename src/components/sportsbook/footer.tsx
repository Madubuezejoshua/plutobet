import Link from "next/link";

/**
 * Footer.
 *
 * WHAT IS DELIBERATELY ABSENT: any licence claim. The previous site displayed
 * "Nigeria · Licensed operator" with nothing behind it. A licence statement on
 * a betting site is a regulatory assertion, not decoration, and publishing one
 * before the licence exists is the kind of claim that ends an application.
 *
 * The 18+ and responsible-gambling notices stay, because those are obligations
 * rather than credentials, and they are true today.
 */

const COLUMNS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Betting",
    links: [
      { href: "/sports", label: "Sports" },
      { href: "/live", label: "Live betting" },
      { href: "/jackpot", label: "Jackpot" },
      { href: "/bets", label: "My bets" },
      { href: "/results", label: "Results" },
    ],
  },
  {
    title: "Account",
    links: [
      { href: "/wallet", label: "Wallet" },
      { href: "/deposit", label: "Deposit" },
      { href: "/withdraw", label: "Withdraw" },
      { href: "/account", label: "Account details" },
      { href: "/kyc", label: "Identity verification" },
    ],
  },
  {
    title: "Safer gambling",
    links: [
      { href: "/responsible", label: "Deposit and loss limits" },
      { href: "/responsible#self-exclusion", label: "Self-exclusion" },
      { href: "/responsible#reality-check", label: "Reality checks" },
    ],
  },
];

export function SportsbookFooter() {
  return (
    <footer
      style={{
        background: "var(--sb-shell)",
        color: "var(--sb-shell-muted)",
        borderTop: "1px solid var(--sb-shell-line)",
        marginTop: "var(--sb-6)",
      }}
    >
      <div
        style={{
          maxWidth: "var(--sb-max)", margin: "0 auto",
          padding: "var(--sb-6) var(--sb-3)",
          display: "grid", gap: "var(--sb-6)",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        }}
      >
        {COLUMNS.map((column) => (
          <div key={column.title}>
            <h2
              style={{
                fontSize: "var(--sb-t-xs)", fontWeight: 700, letterSpacing: "0.06em",
                textTransform: "uppercase", color: "var(--sb-shell-ink)",
                margin: "0 0 var(--sb-2)",
              }}
            >
              {column.title}
            </h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    style={{ color: "inherit", textDecoration: "none", fontSize: "var(--sb-t-base)" }}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div
        style={{
          borderTop: "1px solid var(--sb-shell-line)",
          padding: "var(--sb-4) var(--sb-3)",
        }}
      >
        <div
          style={{
            maxWidth: "var(--sb-max)", margin: "0 auto",
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--sb-3)",
            fontSize: "var(--sb-t-sm)",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, borderRadius: "50%",
              border: "2px solid var(--sb-shell-muted)", fontWeight: 800, fontSize: 11,
              color: "var(--sb-shell-ink)", flex: "none",
            }}
          >
            18+
          </span>
          <p style={{ margin: 0, maxWidth: 620 }}>
            You must be 18 or older to open an account or place a bet. Betting can be addictive.
            Set a limit before you play — <Link href="/responsible" style={{ color: "var(--sb-brand)" }}>
              take control of your betting
            </Link>.
          </p>
          <span style={{ marginLeft: "auto", fontSize: "var(--sb-t-xs)" }}>
            © {new Date().getFullYear()} PlutoBet
          </span>
        </div>
      </div>
    </footer>
  );
}
