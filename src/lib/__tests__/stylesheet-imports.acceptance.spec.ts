import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The entry stylesheet's `@import` block.
 *
 * WHY THIS TEST EXISTS. CSS requires `@import` to precede every other rule
 * except `@charset` and `@layer`. Tailwind v4's `@source` is neither, so an
 * `@import` written below it is invalid and is dropped.
 *
 * It was dropped. Four stylesheets — every token, every surface, the entire
 * redesigned interface — sat below `@source` and never reached the browser.
 * `tsc` was clean, `eslint` was clean, `vitest` was green and `next build`
 * exited 0, because none of those tools reads CSS ordering. The only symptom
 * was a screenshot of unstyled HTML.
 *
 * A rule that is invisible to every other gate needs a gate of its own.
 */

const globalsPath = fileURLToPath(new URL("../../app/globals.css", import.meta.url));
const globals = readFileSync(globalsPath, "utf8");

/** Strips comments so an `@import` mentioned in prose is not mistaken for one. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("globals.css import ordering", () => {
  const css = withoutComments(globals);

  it("puts every @import before the first rule that ends the import block", () => {
    const lines = css.split("\n");
    const firstBlocking = lines.findIndex((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return false;
      if (trimmed.startsWith("@import")) return false;
      if (trimmed.startsWith("@charset")) return false;
      // A bare `@layer a, b;` declaration is also permitted before imports.
      if (/^@layer\s+[\w\s,]+;$/.test(trimmed)) return false;
      return true;
    });

    const lastImport = lines.reduce(
      (last, line, index) => (line.trim().startsWith("@import") ? index : last),
      -1,
    );

    expect(lastImport, "globals.css has no @import at all").toBeGreaterThan(-1);
    expect(
      lastImport,
      `an @import on line ${lastImport + 1} sits after the rule on line ${firstBlocking + 1}, ` +
        "so the browser will silently discard it",
    ).toBeLessThan(firstBlocking);
  });

  it("still imports every stylesheet the interface is built from", () => {
    for (const sheet of [
      "tailwindcss",
      "../styles/tokens.css",
      "../styles/sportsbook.css",
      "../styles/surfaces.css",
      "../styles/legacy-bridge.css",
    ]) {
      expect(css, `${sheet} is no longer imported`).toContain(sheet);
    }
  });

  it("keeps the design tokens in one file", () => {
    // Components reference token names and never hex values, so a colour
    // change is a change to `tokens.css` and nothing else. A stray hex in a
    // component stylesheet is how a palette quietly forks in two.
    const tokens = readFileSync(
      fileURLToPath(new URL("../../styles/tokens.css", import.meta.url)),
      "utf8",
    );
    expect(tokens).toContain("--sb-brand:");
    expect(tokens).toContain("--sb-h-touch:");
  });
});
