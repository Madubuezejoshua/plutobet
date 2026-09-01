/**
 * A secret scanner that cannot leak what it finds.
 *
 *   node scripts/secret-scan.mjs            # scan tracked files
 *   node scripts/secret-scan.mjs --staged   # scan the staged diff only
 *
 * THE DESIGN CONSTRAINT
 * ---------------------
 * A scanner that prints the offending line publishes the secret into CI logs,
 * pull-request checks and anybody's terminal scrollback — turning a warning
 * into a second, more durable exposure. So the matched text NEVER leaves this
 * process. Findings are reported as file, line number and rule name only.
 *
 * That is also why matches are not echoed back for "context": there is no way
 * to show a credential's surroundings without showing the credential.
 *
 * Exit codes: 0 clean, 1 findings, 2 the scanner itself failed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/**
 * Values that are not secrets even though they match a secret's shape.
 *
 * A scanner nobody trusts is a scanner nobody reads. Every finding it reports
 * has to be worth opening, so the obvious non-secrets are excluded by RULE
 * rather than by adding files to an allowlist — allowlisting a file stops it
 * being scanned for the real thing too.
 *
 * The matched text is inspected here, in process, and still never printed.
 */
const PLACEHOLDER = /change[-_]?me|generate[-_]a|replace[-_]?me|your[-_]|example|placeholder|dummy|xxx+|\.\.\.|<[^>]+>/i;

/** A `${...}` interpolation is code assembling a URL, not a literal credential. */
function isInterpolated(match) {
  return match.includes("${") || match.includes("$(");
}

function benignUrl(match) {
  if (isInterpolated(match)) return true;
  if (PLACEHOLDER.test(match)) return true;
  // Loopback with a literal password is a local development fixture. A real
  // hosted credential never points at 127.0.0.1.
  return /@(?:127\.0\.0\.1|localhost|\[::1\])[:/]/i.test(match);
}

const RULES = [
  // Provider-shaped keys. Prefixes are public knowledge; the secret is the tail.
  { name: "neon-database-password", re: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{8,}@[^\s"'`]+/i, benign: benignUrl },
  { name: "redis-url-password", re: /rediss?:\/\/[^\s:@/]*:[^\s@/]{8,}@[^\s"'`]+/i, benign: benignUrl },
  { name: "stripe-live-key", re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: "paystack-secret-key", re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "backblaze-app-key", re: /\bK00[0-9a-zA-Z]{28,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "inngest-signing-key", re: /\bsignkey-(?:prod|test)-[0-9a-f]{32,}\b/ },
  { name: "jwt-with-payload", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // Assignment of a long opaque value to an obviously secret-shaped name.
  {
    name: "hardcoded-secret-assignment",
    re: /\b(?:IDENTITY_PEPPER|AUTH_SECRET|NEXTAUTH_SECRET|ODDS_API_KEY|PAYSTACK_SECRET_KEY|INNGEST_EVENT_KEY|INNGEST_SIGNING_KEY|B2_APPLICATION_KEY|SENTRY_AUTH_TOKEN)\s*[:=]\s*["'][^"'\s]{16,}["']/,
    benign: (match) => isInterpolated(match) || PLACEHOLDER.test(match),
  },
];

/**
 * Paths whose matches are expected and harmless.
 *
 * Deliberately narrow. `.env*` is not listed as an EXCEPTION — it is excluded
 * from the scan set entirely because it is gitignored and never tracked; if one
 * ever becomes tracked, the tracked-file listing will pick it up and it should
 * fail loudly.
 */
const ALLOW = [
  // Documents the scanner's own rules.
  /^scripts[\\/]secret-scan\.mjs$/,
  // Lockfiles carry integrity hashes that look like opaque blobs.
  /^package-lock\.json$/,
];

/**
 * Literal strings that are known-safe by inspection.
 *
 * Each one must be a value that is worthless if published. The test signing
 * secret is fixed, never used outside the test process, and named so it cannot
 * be mistaken for a real credential.
 */
const KNOWN_SAFE = [
  // The fixed test signing secret. Never leaves the test process, signs nothing
  // that outlives it, and is named so it cannot be mistaken for a real value.
  "vitest-only-secret-not-a-credential-000000",
  // A deliberately WRONG pepper, used by the KYC tests to prove that a digest
  // made under one pepper cannot be read under another. Its whole purpose is to
  // be the value that does not work.
  "a-completely-different-pepper-32-chars!!",
];

function tracked() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

function stagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function isProbablyText(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return false;
  } catch {
    return false;
  }
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3|wasm)$/i.test(file);
}

function main() {
  const staged = process.argv.includes("--staged");
  const files = (staged ? stagedFiles() : tracked()).filter(
    (f) => isProbablyText(f) && !ALLOW.some((rule) => rule.test(f)),
  );

  const findings = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (KNOWN_SAFE.some((safe) => line.includes(safe))) continue;
      for (const rule of RULES) {
        const match = rule.re.exec(line);
        if (!match) continue;
        // Inspected in memory, never printed — see the header.
        if (rule.benign?.(match[0])) continue;
        // File and line only. The matched text is never captured, stored or
        // printed — that is the entire point of this script.
        findings.push({ file, line: index + 1, rule: rule.name });
      }
    }
  }

  console.log(`secret-scan: ${files.length} file(s) scanned, ${RULES.length} rule(s)`);
  if (findings.length === 0) {
    console.log("secret-scan: clean");
    return 0;
  }

  console.error(`secret-scan: ${findings.length} finding(s) — values withheld by design`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]`);
  }
  console.error("");
  console.error("Open each location yourself. If a match is a false positive, add a narrow");
  console.error("rule to ALLOW or KNOWN_SAFE in scripts/secret-scan.mjs with a reason.");
  console.error("If it is real: rotate the credential FIRST, then remove it from the file.");
  return 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error("secret-scan: scanner failed:", error instanceof Error ? error.message : error);
  process.exit(2);
}
