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
    <footer className="sb-footer">
      <div className="sb-footer__grid">
        {COLUMNS.map((column) => (
          <div key={column.title}>
            <h2 className="sb-footer__heading">{column.title}</h2>
            <ul className="sb-footer__list">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="sb-footer__link">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="sb-footer__bar">
        <div className="sb-footer__barinner">
          <span aria-hidden="true" className="sb-footer__age">18+</span>
          <p className="sb-footer__note">
            You must be 18 or older to open an account or place a bet. Betting can be addictive.
            Set a limit before you play — <Link href="/responsible" className="sb-footer__cta">
              take control of your betting
            </Link>.
          </p>
          <span className="sb-footer__copy">
            © {new Date().getFullYear()} PlutoBet
          </span>
        </div>
      </div>
    </footer>
  );
}
