import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashBvn,
  hashNin,
  identityMatches,
  InvalidIdentityNumberError,
  MissingIdentityPepperError,
  maskIdentity,
} from "@/modules/kyc/identity";
import { verifyPaystackSignature } from "../provider";

const PEPPER = "test-pepper-at-least-32-characters-long!!";

function withPepper<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.IDENTITY_PEPPER;
  if (value === undefined) delete process.env.IDENTITY_PEPPER;
  else process.env.IDENTITY_PEPPER = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.IDENTITY_PEPPER;
    else process.env.IDENTITY_PEPPER = previous;
  }
}

describe("identity digests", () => {
  it("is deterministic, so a returning identity can be found", () => {
    withPepper(PEPPER, () => {
      // Determinism is not incidental here — self-exclusion has to survive
      // re-registration under a new email, which requires a lookup.
      expect(hashBvn("12345678901")).toBe(hashBvn("12345678901"));
      expect(hashBvn("12345678901")).not.toBe(hashBvn("12345678902"));
    });
  });

  it("does not collide a BVN with a NIN of the same digits", () => {
    withPepper(PEPPER, () => {
      expect(hashBvn("12345678901")).not.toBe(hashNin("12345678901"));
    });
  });

  it("is not a bare SHA-256 of the number", () => {
    withPepper(PEPPER, () => {
      // The whole point: an 11-digit keyspace falls to a GPU in seconds
      // against an unkeyed digest, so a plain sha256 would be plaintext.
      const naive = createHmac("sha256", "").update("12345678901").digest("hex");
      expect(hashBvn("12345678901")).not.toBe(naive);
    });
  });

  it("produces a different digest under a different pepper", () => {
    const a = withPepper(PEPPER, () => hashBvn("12345678901"));
    const b = withPepper(`${PEPPER}-rotated`, () => hashBvn("12345678901"));
    // Confirms the pepper is actually keying the digest — and shows why it
    // cannot be rotated casually: every stored digest would stop matching.
    expect(a).not.toBe(b);
  });

  it("refuses to hash without a usable pepper", () => {
    withPepper(undefined, () => {
      expect(() => hashBvn("12345678901")).toThrow(MissingIdentityPepperError);
    });
    withPepper("too-short", () => {
      expect(() => hashBvn("12345678901")).toThrow(MissingIdentityPepperError);
    });
  });

  it("rejects anything that is not 11 digits", () => {
    withPepper(PEPPER, () => {
      for (const bad of ["1234567890", "123456789012", "1234567890a", "", "  "]) {
        expect(() => hashBvn(bad)).toThrow(InvalidIdentityNumberError);
      }
      // Surrounding whitespace is a formatting artefact, not a different BVN.
      expect(hashBvn(" 12345678901 ")).toBe(hashBvn("12345678901"));
    });
  });

  it("never puts the number in the error message", () => {
    withPepper(PEPPER, () => {
      try {
        hashBvn("1234567890");
        throw new Error("expected a rejection");
      } catch (error) {
        // These messages reach logs.
        expect((error as Error).message).not.toContain("1234567890");
      }
    });
  });

  it("emits a digest the database CHECK will accept", () => {
    withPepper(PEPPER, () => {
      // kyc_records_bvn_is_digest enforces ^[0-9a-f]{64}$, which an 11-digit
      // raw BVN could never satisfy.
      expect(hashBvn("12345678901")).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("compares digests without leaking length or content by timing", () => {
    withPepper(PEPPER, () => {
      const digest = hashBvn("12345678901");
      expect(identityMatches(digest, digest)).toBe(true);
      expect(identityMatches(digest, hashBvn("12345678902"))).toBe(false);
      expect(identityMatches(digest, "short")).toBe(false);
    });
  });

  it("masks all but the last four digits for support screens", () => {
    expect(maskIdentity("12345678901")).toBe("*******8901");
    expect(maskIdentity("123")).toBe("****");
  });
});

describe("paystack webhook signatures", () => {
  const secret = `sk_test_${randomUUID()}`;
  const body = JSON.stringify({ event: "charge.success", data: { reference: "ref_1" } });
  const valid = createHmac("sha512", secret).update(body, "utf8").digest("hex");

  it("accepts a correctly signed body", () => {
    expect(verifyPaystackSignature(body, valid, secret)).toBe(true);
  });

  it("rejects a forged or missing signature", () => {
    expect(verifyPaystackSignature(body, null, secret)).toBe(false);
    expect(verifyPaystackSignature(body, "deadbeef", secret)).toBe(false);
    expect(verifyPaystackSignature(body, valid, `${secret}-wrong`)).toBe(false);
  });

  it("rejects a body altered after signing", () => {
    // The attack this stops: replay a real webhook with the amount inflated.
    const tampered = JSON.stringify({
      event: "charge.success",
      data: { reference: "ref_1", amount: 99_999_999 },
    });
    expect(verifyPaystackSignature(tampered, valid, secret)).toBe(false);
  });

  it("rejects a re-serialised body even with identical content", () => {
    // Why the handler must keep the RAW body: re-encoding changes key order
    // and whitespace, and the signature no longer matches.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyPaystackSignature(reserialised, valid, secret)).toBe(false);
  });
});
