import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { assertSameOrigin } from "../handler";

/**
 * The same-origin guard, exhaustively.
 *
 * WHY THIS IS A UNIT SUITE AS WELL AS A BROWSER ONE. The browser suite proves
 * the guard is REACHED on the real routes and that legitimate traffic still
 * works. It cannot cheaply enumerate header combinations, and this control is
 * defined entirely by which combinations it refuses — including several a
 * browser will not produce on demand. Both halves are needed and neither
 * replaces the other.
 *
 * TWO CASES BELOW WERE ANSWERED 201 BY THE RUNNING SERVER before this pass: a
 * cross-site fetch-metadata header, and a hostile Referer with no Origin.
 */

const HOST = "app.example.com";

function req(method: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(`https://${HOST}/api/withdrawals`, {
    method,
    headers: { host: HOST, ...headers },
  });
}

function refused(method: string, headers: Record<string, string>): boolean {
  try {
    assertSameOrigin(req(method, headers));
    return false;
  } catch {
    return true;
  }
}

describe("same-origin guard — what it lets through", () => {
  it("allows a genuine same-origin browser fetch", () => {
    expect(
      refused("POST", {
        origin: `https://${HOST}`,
        "sec-fetch-site": "same-origin",
        referer: `https://${HOST}/withdraw`,
      }),
    ).toBe(false);
  });

  it("allows a same-site request, which is not cross-site", () => {
    expect(refused("POST", { origin: `https://${HOST}`, "sec-fetch-site": "same-site" })).toBe(false);
  });

  it("allows a user-initiated navigation, which reports sec-fetch-site: none", () => {
    expect(refused("POST", { "sec-fetch-site": "none" })).toBe(false);
  });

  /*
   * ABSENT IS ALLOWED, DELIBERATELY, and this test is the record of that
   * decision rather than an oversight. Native apps and server-to-server callers
   * send no Origin. Refusing them would break real traffic and stop no browser
   * attack, because an attacker running inside a browser cannot omit the
   * header — the browser sets it for them.
   */
  it("allows a request with no origin, referer or fetch metadata at all", () => {
    expect(refused("POST", {})).toBe(false);
  });

  it("never inspects a read", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(refused(method, { origin: "https://evil.example.com" })).toBe(false);
    }
  });

  it("allows a same-origin Referer when Origin is absent", () => {
    expect(refused("POST", { referer: `https://${HOST}/withdraw` })).toBe(false);
  });

  it("compares against the forwarded host when a proxy sets one", () => {
    const request = new NextRequest("https://internal.local/api/withdrawals", {
      method: "POST",
      headers: {
        host: "internal.local",
        "x-forwarded-host": HOST,
        origin: `https://${HOST}`,
      },
    });
    // The customer's browser saw app.example.com; comparing against the
    // internal host would refuse every legitimate request behind the proxy.
    expect(() => assertSameOrigin(request)).not.toThrow();
  });
});

describe("same-origin guard — what it refuses", () => {
  it("refuses a hostile Origin", () => {
    expect(refused("POST", { origin: "https://evil.example.com" })).toBe(true);
  });

  /*
   * REGRESSION — this answered 201. `Sec-Fetch-Site` is a forbidden header
   * name, so page script cannot forge it: when it says cross-site, the browser
   * is stating that somebody else's page caused this request. Accepting it
   * while waiting for `Origin` to agree was the gap.
   */
  it("refuses cross-site fetch metadata even when nothing else is suspicious", () => {
    expect(refused("POST", { "sec-fetch-site": "cross-site" })).toBe(true);
  });

  it("refuses cross-site fetch metadata even when the Origin looks correct", () => {
    expect(refused("POST", { origin: `https://${HOST}`, "sec-fetch-site": "cross-site" })).toBe(true);
  });

  /*
   * REGRESSION — this answered 201. Referer was not read at all, so stripping
   * Origin was enough to walk past the guard.
   */
  it("refuses a hostile Referer when Origin is absent", () => {
    expect(refused("POST", { referer: "https://evil.example.com/attack" })).toBe(true);
  });

  it("prefers Origin over Referer rather than letting Referer overrule it", () => {
    expect(
      refused("POST", { origin: "https://evil.example.com", referer: `https://${HOST}/withdraw` }),
    ).toBe(true);
  });

  it("refuses an unparseable Origin instead of ignoring it", () => {
    expect(refused("POST", { origin: "not-a-url" })).toBe(true);
  });

  it("refuses every state-changing verb, not only POST", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(refused(method, { origin: "https://evil.example.com" })).toBe(true);
    }
  });

  it("says the same thing however it was caught", () => {
    // A refusal that named the deciding signal would tell an attacker which
    // header to strip next.
    const messages = new Set<string>();
    const cases: Record<string, string>[] = [
      { origin: "https://evil.example.com" },
      { "sec-fetch-site": "cross-site" },
      { referer: "https://evil.example.com/x" },
      { origin: "not-a-url" },
    ];
    for (const headers of cases) {
      try {
        assertSameOrigin(req("POST", headers));
      } catch (error) {
        messages.add((error as { message: string }).message);
      }
    }
    expect(messages.size).toBe(1);
  });
});
