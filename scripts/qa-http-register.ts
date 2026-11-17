/**
 * Stage 6: register through the REAL public HTTP route.
 *
 *   npm run dev            # in another terminal
 *   npx tsx scripts/qa-http-register.ts [baseUrl]
 *
 * Drives `POST /api/auth/otp` then `POST /api/auth/register` over HTTP — the
 * same endpoints the browser form posts to — rather than calling the service
 * directly. That difference matters: the route layer adds Zod validation, rate
 * limiting and the OTP requirement, none of which a service-level test
 * exercises.
 *
 * The one-time code comes from the console-provider dev path, which is
 * returned ONLY when no SMS vendor is configured and is now refused outright
 * in production. It is an existing, gated development affordance, not a bypass
 * added for this script.
 */
import "dotenv/config";

const BASE = process.argv[2]?.replace(/\/$/, "") ?? "http://localhost:3000";

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: Step[] = [];
function record(name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name.padEnd(42)} ${detail}`);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
}

async function freshCode(phoneNumber: string): Promise<string | null> {
  const res = await post("/api/auth/otp", { phoneNumber, purpose: "PHONE_VERIFY" });
  return typeof res.body.devCode === "string" ? res.body.devCode : null;
}

async function main() {
  const stamp = Date.now();
  const email = `qa-http-${stamp}@plutobet.test`;
  const phoneNumber = `0803${String(stamp).slice(-7)}`;
  const password = `Qa-${stamp.toString(36)}-Aa9!`;
  const dateOfBirth = "1995-06-15";

  console.log(`base : ${BASE}`);
  console.log(`email: ${email}\n`);

  // ---- 1. request the OTP over HTTP ------------------------------------
  const otpRes = await post("/api/auth/otp", { phoneNumber, purpose: "PHONE_VERIFY" });
  const devCode = typeof otpRes.body.devCode === "string" ? otpRes.body.devCode : null;
  record(
    "POST /api/auth/otp",
    otpRes.status === 200,
    `HTTP ${otpRes.status}${devCode ? " (dev code issued)" : " (no dev code — provider configured?)"}`,
  );

  if (!devCode) {
    record(
      "registration",
      false,
      "BLOCKED_BY_KEY — no dev code and no SMS vendor; cannot complete HTTP registration",
    );
    process.exit(2);
  }

  // ---- 2. underage must be refused BEFORE the happy path ---------------
  const underagePhone = `0805${String(stamp).slice(-7)}`;
  const underageCode = (await freshCode(underagePhone)) ?? devCode;
  const underage = await post("/api/auth/register", {
    email: `qa-underage-${stamp}@plutobet.test`,
    password,
    phoneNumber: underagePhone,
    otp: underageCode,
    dateOfBirth: new Date(Date.now() - 17 * 365 * 864e5).toISOString().slice(0, 10),
  });
  record("underage registration refused", underage.status >= 400, `HTTP ${underage.status}`);

  // ---- 3. the real registration ----------------------------------------
  // A fresh code: OTPs are single-use, so the underage attempt above consumed
  // the previous one. That is correct behaviour, not a defect.
  const liveCode = (await freshCode(phoneNumber)) ?? devCode;
  const reg = await post("/api/auth/register", {
    email,
    password,
    phoneNumber,
    otp: liveCode,
    dateOfBirth,
    firstName: "QA",
    lastName: "Http",
  });
  const userId = typeof reg.body.userId === "string" ? reg.body.userId : null;
  record("POST /api/auth/register", reg.status < 300, `HTTP ${reg.status} ${userId ?? JSON.stringify(reg.body).slice(0, 120)}`);

  if (!userId) {
    console.log("\nno userId returned — cannot continue");
    process.exit(1);
  }

  // ---- 4. duplicate email must be refused ------------------------------
  const dupOtp = await post("/api/auth/otp", {
    phoneNumber: `0806${String(stamp).slice(-7)}`,
    purpose: "PHONE_VERIFY",
  });
  const dupCode = typeof dupOtp.body.devCode === "string" ? dupOtp.body.devCode : devCode;
  const dup = await post("/api/auth/register", {
    email,
    password,
    phoneNumber: `0806${String(stamp).slice(-7)}`,
    otp: dupCode,
    dateOfBirth,
  });
  record("duplicate email refused", dup.status >= 400, `HTTP ${dup.status}`);

  console.log(`\nUSER_ID=${userId}`);
  console.log(`EMAIL=${email}`);

  const failed = steps.filter((s) => !s.ok);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("qa-http-register failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
