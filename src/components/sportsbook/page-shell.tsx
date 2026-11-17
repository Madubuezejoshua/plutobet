import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

/**
 * The container every non-board page sits in.
 *
 * The board and the auth pages manage their own full-width layouts. Everything
 * else — wallet, deposit, account, results — is a document, and a document
 * wants one measured column with a heading, not the full 1440px.
 *
 * `back` is a real link to a real page, never `history.back()`. A customer who
 * arrived from a notification or a shared URL has no history to go back to,
 * and a back control that does nothing is worse than no back control.
 */

export function PageShell({
  title,
  sub,
  back,
  aside,
  width = "default",
  children,
}: {
  title?: string;
  sub?: ReactNode;
  back?: { href: string; label: string };
  aside?: ReactNode;
  width?: "narrow" | "default" | "wide";
  children: ReactNode;
}) {
  const widthClass =
    width === "narrow" ? " sb-page--narrow" : width === "wide" ? " sb-page--wide" : "";

  return (
    <div className={`sb-page${widthClass}`}>
      {title || back ? (
        <header className="sb-pagehead">
          {back ? (
            <Link href={back.href} className="sb-pagehead__back">
              <ChevronLeft size={15} aria-hidden="true" />
              {back.label}
            </Link>
          ) : null}
          {title ? (
            <div className="sb-pagehead__row">
              <div style={{ minWidth: 0 }}>
                <h1>{title}</h1>
                {sub ? <p className="sb-pagehead__sub">{sub}</p> : null}
              </div>
              {aside ? <div className="sb-pagehead__aside">{aside}</div> : null}
            </div>
          ) : null}
        </header>
      ) : null}
      {children}
    </div>
  );
}
