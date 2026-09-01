import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { OtpService } from "../otp.service";
import { ConsoleEmailProvider, ConsoleSmsProvider } from "../provider";
import type { EmailProvider, SmsProvider } from "../provider";

/**
 * The console OTP fallback must not leak a code in production.
 *
 * `issue()` returns `devCode` whenever the active provider is the console one,
 * so a production deployment missing vendor keys would hand the one-time code
 * back in the API response. That is a complete verification bypass: anyone
 * could request a code for a destination they do not control and verify it —
 * which also defeats self-exclusion and duplicate-identity prevention, because
 * both are keyed to a verified number.
 *
 * The guard sits at the moment a code would be leaked rather than at
 * construction. Guarding construction ALSO broke `next build`:
 * password-reset.service.ts constructs its OtpService at module evaluation and
 * the build runs with NODE_ENV=production, so page-data collection threw on a
 * machine that was never going to serve a request.
 */

const SAVED_ENV = process.env.NODE_ENV;

/** A provider that reports a real vendor name without contacting one. */
function fakeVendor(name: string): SmsProvider & EmailProvider {
  return {
    name,
    sent: [],
    async send() {
      return { providerRef: `fake-${randomUUID()}` };
    },
  } as unknown as SmsProvider & EmailProvider;
}

function service(sms: SmsProvider, email: EmailProvider) {
  // A limiter that always allows, so these tests exercise the production guard
  // rather than the send throttle.
  const limiter = { consume: async () => ({ allowed: true, remaining: 99, resetAt: new Date() }) };
  return new OtpService(undefined, sms, email, limiter as never);
}

afterEach(() => {
  setNodeEnv(SAVED_ENV);
});

/** NODE_ENV is readonly in the Node types; a plain write is what actually works. */
function setNodeEnv(value: string | undefined) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

describe("OTP console-fallback production guard", () => {
  it("refuses to issue an SMS code in production with no SMS vendor", async () => {
    setNodeEnv("production");
    const otp = service(new ConsoleSmsProvider(), fakeVendor("resend"));

    await expect(
      otp.issue({
        destination: "08031234567",
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        ip: "102.89.0.1",
      }),
    ).rejects.toThrow(/TERMII_API_KEY/);
  });

  it("refuses to issue an email code in production with no email vendor", async () => {
    setNodeEnv("production");
    const otp = service(fakeVendor("termii"), new ConsoleEmailProvider());

    await expect(
      otp.issue({
        destination: "someone@plutobet.test",
        channel: "EMAIL",
        purpose: "EMAIL_VERIFY",
        ip: "102.89.0.1",
      }),
    ).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("explains the CONSEQUENCE, not merely that a variable is missing", async () => {
    setNodeEnv("production");
    const otp = service(new ConsoleSmsProvider(), new ConsoleEmailProvider());

    // An operator reading this at 2am needs to know why it refused, or they
    // will be tempted to work around it.
    await expect(
      otp.issue({
        destination: "08031234567",
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        ip: "102.89.0.1",
      }),
    ).rejects.toThrow(/verify a destination they do not control/);
  });

  it("does NOT block construction — the build evaluates these modules in production", () => {
    setNodeEnv("production");
    // password-reset.service.ts builds an OtpService at module scope. If
    // constructing one threw, `next build` would fail while collecting page
    // data, which is what happened when the guard sat in the factory.
    expect(() => service(new ConsoleSmsProvider(), new ConsoleEmailProvider())).not.toThrow();
  });

  it("allows the console fallback outside production", async () => {
    setNodeEnv("development");
    const otp = service(new ConsoleSmsProvider(), new ConsoleEmailProvider());

    // Local development must still complete registration end to end without
    // buying credentials — removing that would make the flow untestable.
    await expect(
      otp.issue({
        destination: "08031234567",
        channel: "SMS",
        purpose: "PHONE_VERIFY",
        ip: "102.89.0.1",
      }),
    ).rejects.not.toThrow(/refusing to issue/);
  });
});
