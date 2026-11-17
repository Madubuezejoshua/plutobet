import { describe, expect, it } from "vitest";
import { DEFAULT_CALLBACK, safeCallbackPath } from "../safe-redirect";

/**
 * The sign-in page's redirect guard.
 *
 * This is a security control, not a convenience: the whole value of a phishing
 * page is that the address bar says PlutoBet while the destination does not.
 */

describe("safeCallbackPath", () => {
  it("keeps a path on this site", () => {
    expect(safeCallbackPath("/wallet")).toBe("/wallet");
    expect(safeCallbackPath("/account/security")).toBe("/account/security");
  });

  it("keeps a query string and a fragment", () => {
    expect(safeCallbackPath("/sports?league=England%20-%20Premier%20League")).toBe(
      "/sports?league=England%20-%20Premier%20League",
    );
    expect(safeCallbackPath("/sports#markets")).toBe("/sports#markets");
  });

  it("falls back when there is no destination", () => {
    expect(safeCallbackPath(undefined)).toBe(DEFAULT_CALLBACK);
    expect(safeCallbackPath(null)).toBe(DEFAULT_CALLBACK);
    expect(safeCallbackPath("")).toBe(DEFAULT_CALLBACK);
    expect(safeCallbackPath("   ")).toBe(DEFAULT_CALLBACK);
  });

  it("refuses another origin", () => {
    for (const hostile of [
      "https://evil.example/pluto",
      "http://evil.example",
      "//evil.example",
      "//evil.example/wallet",
      "/\\evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "mailto:someone@example.com",
      "wallet", // not rooted; would resolve relative to the current path
      " https://evil.example",
    ]) {
      expect(safeCallbackPath(hostile), `expected ${hostile} to be refused`).toBe(
        DEFAULT_CALLBACK,
      );
    }
  });

  it("refuses a path carrying control characters", () => {
    expect(safeCallbackPath("/wallet\nSet-Cookie: x=1")).toBe(DEFAULT_CALLBACK);
    expect(safeCallbackPath("/wallet\r\n/evil")).toBe(DEFAULT_CALLBACK);
    expect(safeCallbackPath("/wallet" + String.fromCharCode(0))).toBe(DEFAULT_CALLBACK);
  });

  it("trims a path rather than refusing it for surrounding space", () => {
    expect(safeCallbackPath("  /wallet  ")).toBe("/wallet");
  });

  it("returns a path that always starts with a single slash", () => {
    // Anything this function returns is handed to a router. If it could ever
    // return something not rooted on this site, every caller would need its
    // own check — which is exactly the situation this replaced.
    for (const input of ["/a", "//b", "https://c", "", "d", "/\\e"]) {
      const result = safeCallbackPath(input);
      expect(result.startsWith("/")).toBe(true);
      expect(result.startsWith("//")).toBe(false);
    }
  });
});
