/**
 * Where a sign-in is allowed to send someone afterwards.
 *
 * An open redirect on a sign-in page is a phishing tool: an attacker sends
 * `/signin?callbackUrl=https://evil.example/pluto`, the victim sees a genuine
 * PlutoBet domain in the address bar, signs in, and is handed to a page that
 * asks them to "confirm" their password. The redirect is the whole trick.
 *
 * So the rule is not "reject known-bad", it is "accept only a path on this
 * site". Anything else falls back to the board.
 *
 * The cases this rejects, and why each one matters:
 *
 *   https://evil.example   an absolute URL to another origin
 *   //evil.example         protocol-relative; a browser treats it as absolute
 *   /\evil.example         backslash; some parsers normalise it to a slash
 *   javascript:...         a scheme that runs code rather than navigating
 *   (empty / undefined)    no destination at all
 *
 * A query string and a fragment are allowed, because a legitimate callback
 * often carries both (`/sports?league=...#markets`).
 */

export const DEFAULT_CALLBACK = "/sports";

/** Control characters, which can smuggle a value past a check further down. */
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001F\\u007F]");

export function safeCallbackPath(raw: string | undefined | null): string {
  if (typeof raw !== "string") return DEFAULT_CALLBACK;

  const value = raw.trim();
  if (value === "") return DEFAULT_CALLBACK;

  // Must be a rooted path on this site.
  if (!value.startsWith("/")) return DEFAULT_CALLBACK;

  // `//host` and `/\host` are both read as "another origin" by browsers.
  if (value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_CALLBACK;

  if (CONTROL_CHARACTERS.test(value)) return DEFAULT_CALLBACK;

  return value;
}
