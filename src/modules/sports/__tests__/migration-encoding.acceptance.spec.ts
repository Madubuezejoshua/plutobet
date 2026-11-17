import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migrations must survive the client encoding.
 *
 * A migration file is sent to PostgreSQL as a literal string and re-encoded to
 * the CLIENT encoding. On a default Windows install that is WIN1252, and a
 * character with no equivalent there aborts the ENTIRE migration with
 * `22P05: character with byte sequence ... has no equivalent in encoding
 * "WIN1252"`.
 *
 * Two things make this worth a test rather than a note:
 *
 *  1. The failure is remote from its cause. The error names the first
 *     statement, not the comment thirty lines above it that actually contains
 *     the character, so it reads like a broken CREATE TABLE.
 *
 *  2. It is invisible in review. An em-dash maps to WIN1252 and is fine; an
 *     arrow does not and is fatal. Nothing about the two looks different in a
 *     diff, and a Linux developer whose client encoding is UTF8 will never
 *     reproduce it.
 *
 * This caught a real arrow in 0013 that failed every test run on Windows.
 */
describe("migration encoding", () => {
  const directory = join(process.cwd(), "drizzle");
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql"));

  it("finds the migration files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s contains only WIN1252-representable characters", (name) => {
    const contents = readFileSync(join(directory, name), "utf8");

    const offenders = new Map<string, number>();
    for (let index = 0; index < contents.length; index += 1) {
      const character = contents[index]!;
      if (character.charCodeAt(0) < 128) continue;
      if (isWin1252Representable(character)) continue;

      const label = `${JSON.stringify(character)} (U+${character
        .codePointAt(0)!
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")})`;
      offenders.set(label, (offenders.get(label) ?? 0) + 1);
    }

    expect(
      [...offenders.entries()].map(([label, count]) => `${label} x${count}`),
      `${name} contains characters that will abort the migration on a WIN1252 client. ` +
        "Use plain ASCII in SQL comments (-> not an arrow).",
    ).toEqual([]);
  });
});

/**
 * WIN1252 is Latin-1 plus a specific set of printable characters in 0x80-0x9F.
 *
 * Enumerated explicitly rather than probed with a codec, because Node has no
 * WIN1252 encoder — `TextEncoder` only speaks UTF-8, and getting this wrong in
 * the permissive direction would let the very characters this test exists to
 * catch straight through.
 */
const WIN1252_HIGH_RANGE = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
  0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function isWin1252Representable(character: string): boolean {
  const code = character.codePointAt(0)!;
  // Latin-1 proper: directly representable.
  if (code <= 0xff) return code < 0x80 || code >= 0xa0;
  return WIN1252_HIGH_RANGE.has(code);
}
