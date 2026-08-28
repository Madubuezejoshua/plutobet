/**
 * Runs the odds provider contract test against the LIVE API.
 *
 *   npm run odds:contract
 *
 * Exists as a script rather than an inline env assignment for two reasons:
 * `FOO=1 vitest` is not valid on Windows shells, and vitest does not load
 * `.env`, so `ODDS_API_KEY` would be missing and the live block would skip —
 * silently reporting success while testing nothing.
 */
import "dotenv/config";
import { spawn } from "node:child_process";

if (!process.env.ODDS_API_KEY) {
  console.error("ODDS_API_KEY is not set — the live contract check needs a real key.");
  process.exit(1);
}

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "provider-contract"],
  {
    stdio: "inherit",
    env: { ...process.env, ODDS_LIVE_CONTRACT: "1" },
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
