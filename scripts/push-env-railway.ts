/**
 * Copies local .env values into a linked Railway service.
 *
 *   railway login && railway link
 *   npm run env:push
 *
 * VALUES ARE NEVER PRINTED. Only the variable name and a verdict — set,
 * skipped, or failed. A script that echoes what it is uploading turns a
 * terminal scrollback, and any log capturing it, into a copy of the secrets.
 *
 * Empty values are skipped rather than pushed. Setting PAYSTACK_SECRET_KEY to
 * "" on Railway would be worse than leaving it absent: /api/health reports a
 * missing variable clearly, while an empty one reads as configured until the
 * first payment fails.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Local-only names that must NOT go to a deployment.
 *
 * NEXTAUTH_URL is here because the local value is a localhost address, and a
 * production deployment that thinks it lives on localhost sends every sign-in
 * callback to the customer's own machine. It is set explicitly below instead.
 */
const LOCAL_ONLY = new Set(["NEXTAUTH_URL"]);

function envNames(): string[] {
  const file = readFileSync(".env", "utf8");
  const names: string[] = [];
  for (const line of file.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=/.exec(line.trim());
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function railway(args: string[]): void {
  execFileSync(process.platform === "win32" ? "railway.cmd" : "railway", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function main(): void {
  // Fail before touching anything if the project is not linked, rather than
  // reporting eighteen identical failures.
  try {
    railway(["status"]);
  } catch {
    console.error("Not linked to a Railway project. Run:  railway login && railway link");
    process.exit(1);
  }

  const publicUrl = process.argv[2]?.trim();
  const set: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const name of envNames()) {
    if (LOCAL_ONLY.has(name)) {
      skipped.push(`${name} (local-only)`);
      continue;
    }

    const value = process.env[name]?.trim();
    if (!value) {
      skipped.push(`${name} (empty)`);
      continue;
    }

    try {
      railway(["variables", "--set", `${name}=${value}`]);
      set.push(name);
    } catch {
      failed.push(name);
    }
  }

  if (publicUrl) {
    try {
      railway(["variables", "--set", `NEXTAUTH_URL=${publicUrl}`]);
      set.push("NEXTAUTH_URL");
    } catch {
      failed.push("NEXTAUTH_URL");
    }
  }

  console.log(`\nset (${set.length}):     ${set.join(", ")}`);
  if (skipped.length) console.log(`skipped (${skipped.length}): ${skipped.join(", ")}`);
  if (failed.length) console.log(`FAILED (${failed.length}):  ${failed.join(", ")}`);

  if (!publicUrl) {
    console.log(
      "\nNEXTAUTH_URL was not set. Re-run with the public URL as an argument, e.g.\n" +
        "  npm run env:push -- https://plutobetai-production.up.railway.app",
    );
  }

  console.log("\nAfter Railway redeploys, check /api/health.");
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
