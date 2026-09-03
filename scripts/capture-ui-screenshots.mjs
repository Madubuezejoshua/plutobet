/**
 * Screenshots of the redesigned interface, for visual review before merge.
 *
 *   node scripts/capture-ui-screenshots.mjs --base=http://localhost:3100
 *
 * WHAT IT PHOTOGRAPHS. Whatever is at `--base`. It is the caller's job to point
 * it at a review server backed by a DISPOSABLE database — never production, and
 * never the database holding the 400 synthetic benchmark fixtures, which would
 * put invented matches into a document people use to judge the product.
 *
 * WHY IT DRIVES DEVTOOLS RATHER THAN `--screenshot`.
 *
 * The first version of this script used Chrome's one-shot
 * `--headless --window-size=390,900 --screenshot=…`. The image it produced was
 * 390px wide and the page inside it was laid out at roughly 880px: the window
 * size set the capture, not the viewport. Every "mobile" screenshot was a
 * desktop layout with the right-hand two thirds cropped off — and it looked
 * plausible enough to be mistaken for a real responsive bug, which cost an hour
 * of chasing a CSS problem that did not exist.
 *
 * `Emulation.setDeviceMetricsOverride` sets the layout viewport for real, so a
 * 390px screenshot is a 390px page. It also gives `mobile: true` and a device
 * pixel ratio, which is what a phone actually reports.
 *
 * Nothing is installed for this: Chrome or Edge is already present on any
 * machine that can review the result, and Node's built-in WebSocket speaks
 * DevTools without a client library.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CANDIDATE_BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Desktop, and the phone width most Nigerian Android traffic arrives at. */
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000, mobile: false, scale: 1 },
  { name: "mobile", width: 390, height: 844, mobile: true, scale: 2 },
];

const PAGES = [
  { slug: "01-board", path: "/" },
  { slug: "02-sports", path: "/sports" },
  { slug: "03-signin", path: "/signin" },
  { slug: "04-register", path: "/register" },
  { slug: "05-forgot-password", path: "/forgot-password" },
  { slug: "06-live", path: "/live" },
  { slug: "07-results", path: "/results" },
  { slug: "08-jackpot", path: "/jackpot" },
  { slug: "09-promotions", path: "/promotions" },
  { slug: "10-casino", path: "/casino" },
  { slug: "11-pluto", path: "/pluto" },
  { slug: "12-livescore", path: "/livescore" },
  { slug: "13-fantasy-unavailable", path: "/fantasy" },
];

/*
 * The event page needs a real fixture id, which only the seeded database knows.
 * Pass one with --event=<providerEventId> and it is photographed too; leave it
 * out and it is skipped rather than shot as a 404.
 */
function withEventPage(pages) {
  const id = arg("event", null);
  if (!id) return pages;
  return [...pages, { slug: "14-event", path: `/sports/event/${id}` }];
}

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function findBrowser() {
  const override = arg("browser", null);
  if (override) return override;
  const found = CANDIDATE_BROWSERS.find((path) => existsSync(path));
  if (!found) {
    throw new Error("No Chrome or Edge found. Pass one with --browser=<path>.");
  }
  return found;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Chrome writes its chosen port here once the DevTools endpoint is listening. */
async function waitForDevToolsPort(profileDir) {
  const file = join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, "utf8").split("\n");
      if (port && port.trim() !== "") return Number(port.trim());
    }
    await sleep(100);
  }
  throw new Error("Chrome never reported a DevTools port");
}

/** The smallest CDP client that does the job: send, await the matching id. */
class Devtools {
  #socket;
  #next = 1;
  #pending = new Map();
  #events = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(message.data);
      if (frame.id !== undefined) {
        const waiting = this.#pending.get(frame.id);
        if (!waiting) return;
        this.#pending.delete(frame.id);
        if (frame.error) waiting.reject(new Error(frame.error.message));
        else waiting.resolve(frame.result);
        return;
      }
      const listeners = this.#events.get(frame.method);
      if (listeners) {
        this.#events.set(frame.method, []);
        for (const listener of listeners) listener(frame.params);
      }
    });
  }

  send(method, params = {}) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  once(method, timeoutMs) {
    return new Promise((resolve) => {
      const listeners = this.#events.get(method) ?? [];
      listeners.push(resolve);
      this.#events.set(method, listeners);
      setTimeout(resolve, timeoutMs);
    });
  }

  close() {
    this.#socket.close();
  }
}

async function main() {
  const base = arg("base", "http://localhost:3100").replace(/\/$/, "");
  const outDir = resolve(process.cwd(), arg("out", "artifacts/ui-review"));
  const browser = findBrowser();
  const profileDir = await mkdtemp(join(tmpdir(), "plutobet-shots-"));

  // A stale shot of a page that has since changed is worse than no shot.
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.info(`browser  ${browser}`);
  console.info(`base     ${base}`);
  console.info(`out      ${outDir}\n`);

  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  let taken = 0;
  let failed = 0;

  try {
    const port = await waitForDevToolsPort(profileDir);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page") ?? targets[0];
    if (!page?.webSocketDebuggerUrl) throw new Error("no debuggable page target");

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ready, fail) => {
      socket.addEventListener("open", ready, { once: true });
      socket.addEventListener("error", () => fail(new Error("DevTools socket failed")), {
        once: true,
      });
    });

    const cdp = new Devtools(socket);
    await cdp.send("Page.enable");

    for (const viewport of VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.scale,
        mobile: viewport.mobile,
      });

      for (const target of withEventPage(PAGES)) {
        const file = resolve(outDir, `${target.slug}-${viewport.name}.png`);
        try {
          const loaded = cdp.once("Page.loadEventFired", 30_000);
          await cdp.send("Page.navigate", { url: `${base}${target.path}` });
          await loaded;
          // Server-rendered markup is already there; this is for hydration and
          // for the fonts to settle before the shutter.
          await sleep(700);

          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
          });
          writeFileSync(file, Buffer.from(shot.data, "base64"));
          taken += 1;
          console.info(`  ok    ${viewport.name.padEnd(7)} ${target.path}`);
        } catch (error) {
          failed += 1;
          const reason = error instanceof Error ? error.message : String(error);
          console.error(`  FAIL  ${viewport.name.padEnd(7)} ${target.path} — ${reason}`);
        }
      }
    }

    cdp.close();
  } finally {
    child.kill();
    // Chrome takes a moment to release the profile directory on Windows.
    await sleep(500);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // A leftover temp profile is harmless; failing the run over it is not.
    }
  }

  console.info(`\n${taken} captured, ${failed} failed`);
  // A partial set is still useful for review, so this does not fail the run;
  // the counts above are the record of what was and was not obtained.
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
