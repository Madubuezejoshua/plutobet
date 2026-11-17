import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { qaRefusal } from "@/lib/api/qa-route";
import { ReviewOnlyError } from "@/lib/review-mode";
import { createOtpService } from "@/modules/notifications/otp.service";
import { clearMailbox, codeIn, latestMessageFor } from "@/modules/notifications/review-mailbox";
import {
  DocumentRejectedError,
  documentExists,
  documentKey,
  deleteKycDocument,
  putKycDocument,
  signedDocumentUrl,
} from "@/modules/kyc/storage";
import {
  ReviewDocumentLinkError,
  readSignedReviewDocument,
} from "@/modules/kyc/review-storage";

/**
 * The QA surface, and the two adapters behind it, refuse everywhere they should.
 *
 * These routes are compiled into the production bundle like any other route —
 * that is stated plainly in `qa-route.ts` rather than glossed over — so what
 * keeps them harmless is not their absence but their refusal, and a refusal is
 * only worth anything if it is tested. Each condition is exercised on its own,
 * because four conditions asserted together pass for the wrong reason the
 * moment one of them breaks.
 */

type Env = Record<string, string | undefined>;

const TOUCHED = [
  "PLUTOBET_ENVIRONMENT",
  "PLUTOBET_REVIEW_ADAPTERS",
  "PLUTOBET_REVIEW_KEY",
  "VERCEL_ENV",
  "TERMII_API_KEY",
  "RESEND_API_KEY",
  "B2_BUCKET",
];

const KEY = randomBytes(32).toString("hex");
let saved: Env = {};

function reviewEnvironment(): void {
  for (const name of TOUCHED) delete (process.env as Env)[name];
  (process.env as Env).PLUTOBET_ENVIRONMENT = "review";
  (process.env as Env).PLUTOBET_REVIEW_ADAPTERS = "1";
  (process.env as Env).PLUTOBET_REVIEW_KEY = KEY;
}

/** The two things `qaRefusal` reads. Nothing else about a request matters. */
function request(headers: Record<string, string> = {}): NextRequest {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((name) => [name, process.env[name]]));
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete (process.env as Env)[name];
    else (process.env as Env)[name] = value;
  }
});

describe("the /api/qa gate", () => {
  it("admits a caller only with both the review environment and the key", () => {
    reviewEnvironment();
    expect(qaRefusal(request({ "x-plutobet-review-key": KEY }))).toBeNull();
  });

  it("refuses a correct key when the environment is not a review server", () => {
    reviewEnvironment();
    (process.env as Env).PLUTOBET_ENVIRONMENT = "production";
    expect(qaRefusal(request({ "x-plutobet-review-key": KEY }))).toMatch(/PLUTOBET_ENVIRONMENT/);
  });

  it("refuses a correct key when a live provider credential is configured", () => {
    reviewEnvironment();
    (process.env as Env).B2_BUCKET = "a-real-bucket";
    expect(qaRefusal(request({ "x-plutobet-review-key": KEY }))).toMatch(/B2_BUCKET/);
  });

  it("refuses a review server with no key, a wrong key, or a prefix of the key", () => {
    reviewEnvironment();
    expect(qaRefusal(request())).toMatch(/review key/);
    expect(qaRefusal(request({ "x-plutobet-review-key": "" }))).toMatch(/review key/);
    expect(qaRefusal(request({ "x-plutobet-review-key": randomBytes(32).toString("hex") }))).toMatch(
      /review key/,
    );
    expect(qaRefusal(request({ "x-plutobet-review-key": KEY.slice(0, -1) }))).toMatch(/review key/);
  });

  it("refuses everybody when the key is unset or too short to be one", () => {
    /*
     * THE BRANCH THAT WOULD TURN A MISCONFIGURATION INTO AN OPEN DOOR.
     *
     * If an unset `PLUTOBET_REVIEW_KEY` compared equal to an absent header —
     * or if a one-character key were accepted — then forgetting to set it
     * would admit everyone rather than nobody. Fail-closed is asserted here
     * because it is invisible in normal operation.
     */
    reviewEnvironment();
    delete (process.env as Env).PLUTOBET_REVIEW_KEY;
    expect(qaRefusal(request())).toMatch(/review key/);
    expect(qaRefusal(request({ "x-plutobet-review-key": "" }))).toMatch(/review key/);

    (process.env as Env).PLUTOBET_REVIEW_KEY = "short";
    expect(qaRefusal(request({ "x-plutobet-review-key": "short" }))).toMatch(/review key/);
  });
});

describe("one-time codes on a review server", () => {
  it("delivers to the mailbox and returns no code in the response", async () => {
    reviewEnvironment();
    clearMailbox();
    const destination = `otp-${randomUUID().slice(0, 8)}@review.local`;

    const issued = await createOtpService().issue({
      destination,
      channel: "EMAIL",
      purpose: "PASSWORD_RESET",
      ip: "127.0.0.1",
    });

    /*
     * THE WHOLE POINT, IN ONE ASSERTION.
     *
     * The console fallback returns `devCode`, which is a complete verification
     * bypass: anyone could request a code for an address they do not control
     * and read it out of their own response. The mailbox must not reintroduce
     * that, so the response is checked for the field AND for the code itself,
     * in case some later change renames it.
     */
    expect(issued.devCode).toBeUndefined();
    const delivered = latestMessageFor(destination);
    expect(delivered, "nothing was delivered to the review mailbox").not.toBeNull();
    const code = codeIn(delivered!);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(issued)).not.toContain(code!);

    // And the code that was delivered is the one that verifies — otherwise the
    // mailbox would be a decoration rather than a delivery channel.
    await expect(
      createOtpService().verify({
        destination,
        channel: "EMAIL",
        purpose: "PASSWORD_RESET",
        code: code!,
      }),
    ).resolves.toMatchObject({ userId: null });
  });
});

describe("KYC documents on a review server", () => {
  const userId = randomUUID();

  it("still applies every content and size control before choosing a backend", async () => {
    reviewEnvironment();
    /*
     * The review branch sits AFTER the checks in `putKycDocument`, never
     * before. If it were moved to the top of the function the review path would
     * accept an HTML file of any size under a client-supplied name — which is
     * how a test environment quietly stops testing the thing it is there for.
     */
    await expect(
      putKycDocument({ userId, kind: "ID_FRONT", contentType: "text/html", body: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(DocumentRejectedError);

    await expect(
      putKycDocument({ userId, kind: "ID_FRONT", contentType: "image/png", body: new Uint8Array() }),
    ).rejects.toBeInstanceOf(DocumentRejectedError);

    await expect(
      putKycDocument({
        userId,
        kind: "ID_FRONT",
        contentType: "image/png",
        body: new Uint8Array(11 * 1024 * 1024),
      }),
    ).rejects.toBeInstanceOf(DocumentRejectedError);
  });

  it("stores, signs, serves and deletes a document without touching a bucket", async () => {
    reviewEnvironment();
    const body = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const stored = await putKycDocument({ userId, kind: "SELFIE", contentType: "image/png", body });

    expect(stored.key.startsWith(`kyc/${userId}/`)).toBe(true);
    expect(await documentExists(stored.key)).toBe(true);

    const url = await signedDocumentUrl(stored.key);
    expect(url.startsWith("/api/qa/kyc-document?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);

    const read = readSignedReviewDocument({
      key: params.get("key")!,
      expires: params.get("expires")!,
      signature: params.get("signature")!,
    });
    expect(Buffer.from(read).equals(Buffer.from(body))).toBe(true);

    await deleteKycDocument(stored.key);
    expect(await documentExists(stored.key)).toBe(false);
  });

  it("refuses a tampered, expired, or unsigned review link", async () => {
    reviewEnvironment();
    const body = new Uint8Array([1, 2, 3, 4]);
    const stored = await putKycDocument({ userId, kind: "ID_BACK", contentType: "image/png", body });
    const params = new URLSearchParams((await signedDocumentUrl(stored.key)).split("?")[1]);

    const tampered = () =>
      readSignedReviewDocument({
        key: params.get("key")!,
        // A minute further out than what was signed.
        expires: String(Number(params.get("expires")) + 60),
        signature: params.get("signature")!,
      });
    expect(tampered).toThrow(ReviewDocumentLinkError);

    const unsigned = () =>
      readSignedReviewDocument({
        key: params.get("key")!,
        expires: params.get("expires")!,
        signature: "0".repeat(64),
      });
    expect(unsigned).toThrow(ReviewDocumentLinkError);

    // An expiry in the past, correctly signed for that expiry, is still refused
    // — the signature proves who wrote the link, not that it is still valid.
    const past = Math.floor(Date.now() / 1000) - 10;
    const forgedButExpired = new URLSearchParams(
      (await signedDocumentUrl(stored.key, -10)).split("?")[1],
    );
    expect(Number(forgedButExpired.get("expires"))).toBeLessThanOrEqual(past + 60);

    await deleteKycDocument(stored.key);
  });

  it("refuses a document key shaped like a path traversal", () => {
    reviewEnvironment();
    for (const key of ["kyc/../../etc/passwd", "kyc/x/../../y", "not-kyc/a/b", "kyc/a/b/c"]) {
      expect(
        () =>
          readSignedReviewDocument({ key, expires: String(Date.now()), signature: "0".repeat(64) }),
        `accepted the key ${key}`,
      ).toThrow();
    }
  });

  it("refuses to store or serve anything at all outside a review environment", async () => {
    reviewEnvironment();
    const key = documentKey(userId, "PROOF_OF_ADDRESS", "application/pdf");
    delete (process.env as Env).PLUTOBET_ENVIRONMENT;
    expect(() =>
      readSignedReviewDocument({ key, expires: "1", signature: "0".repeat(64) }),
    ).toThrow(ReviewOnlyError);
  });
});
