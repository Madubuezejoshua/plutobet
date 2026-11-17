/**
 * Starts `next dev` with Inngest in DEV mode.
 *
 *   npm run dev:local          (used by npm run dev:all)
 *
 * WHY A WRAPPER RATHER THAN `INNGEST_DEV=1 next dev`
 * --------------------------------------------------
 * That syntax is a POSIX shell feature. It does nothing on Windows `cmd`,
 * where npm scripts run by default, so the variable would silently not be set
 * and the app would register nothing — the exact failure this exists to
 * prevent, reintroduced by the fix for it. Setting the variable in Node keeps
 * one command working the same way on every machine, with no extra dependency.
 *
 * The variable is scoped to this child process. It never touches `.env`, so it
 * cannot leak into a build or a deployment.
 */
import { spawn } from "node:child_process";

process.env.INNGEST_DEV = "1";

const child = spawn("npx", ["next", "dev"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
