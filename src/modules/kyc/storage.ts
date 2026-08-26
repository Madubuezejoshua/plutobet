import { randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * KYC document storage on Backblaze B2.
 *
 * B2 exposes an S3-compatible API, so this is the standard S3 client pointed
 * at a B2 endpoint. (The build spec named Cloudflare R2; B2 was chosen
 * instead — the interface below is the same either way, so swapping is a
 * config change, not a rewrite.)
 *
 * THE RULES THIS ENFORCES, all of which exist because KYC documents are
 * identity documents — a passport scan leaking is worse than most database
 * breaches:
 *
 *  - The bucket is PRIVATE. Nothing is ever served directly; every read goes
 *    through a short-lived signed URL.
 *  - Object keys are generated SERVER-SIDE from the user id plus random
 *    bytes. A client-supplied filename is never trusted: it invites path
 *    traversal, and a predictable key lets one user guess another's document.
 *  - Content types are allow-listed. An uploaded .html served back from a
 *    signed URL is stored XSS.
 */

const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes: long enough to open, short enough to leak safely
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

export class DocumentRejectedError extends Error {
  constructor(readonly reason: "CONTENT_TYPE" | "TOO_LARGE" | "EMPTY", message: string) {
    super(message);
    this.name = "DocumentRejectedError";
  }
}

export class StorageNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`${missing} is required for KYC document storage`);
    this.name = "StorageNotConfiguredError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new StorageNotConfiguredError(name);
  return value;
}

/**
 * Built lazily rather than at module load so a process that never touches KYC
 * — the odds board, for instance — starts without storage credentials.
 */
let cached: S3Client | null = null;
function client(): S3Client {
  if (cached) return cached;
  cached = new S3Client({
    // e.g. https://s3.eu-central-003.backblazeb2.com
    endpoint: required("B2_ENDPOINT"),
    region: process.env.B2_REGION ?? "us-east-005",
    credentials: {
      accessKeyId: required("B2_KEY_ID"),
      secretAccessKey: required("B2_APPLICATION_KEY"),
    },
  });
  return cached;
}

function bucket(): string {
  return required("B2_BUCKET");
}

export type KycDocumentKind = "ID_FRONT" | "ID_BACK" | "SELFIE" | "PROOF_OF_ADDRESS";

/**
 * Server-generated object key.
 *
 * Namespaced by user so an operator can find and purge one person's documents
 * on request — a data-subject deletion is a real obligation, and an
 * unstructured bucket makes it guesswork. The random suffix means a key
 * cannot be guessed from a user id alone.
 */
export function documentKey(userId: string, kind: KycDocumentKind, contentType: string): string {
  const extension =
    contentType === "application/pdf" ? "pdf" : contentType.replace("image/", "");
  return `kyc/${userId}/${kind.toLowerCase()}-${randomBytes(16).toString("hex")}.${extension}`;
}

export interface StoredDocument {
  key: string;
  bytes: number;
  contentType: string;
}

/**
 * Stores one KYC document and returns its key.
 *
 * The caller records the key on the kyc_records row; the bytes never touch
 * the database.
 */
export async function putKycDocument(params: {
  userId: string;
  kind: KycDocumentKind;
  contentType: string;
  body: Uint8Array;
}): Promise<StoredDocument> {
  if (!ALLOWED_CONTENT_TYPES.has(params.contentType)) {
    // Refusing by allow-list, not by blocking a deny-list: anything not
    // explicitly an image or a PDF has no business in this bucket.
    throw new DocumentRejectedError(
      "CONTENT_TYPE",
      `${params.contentType} is not an accepted document format`,
    );
  }
  if (params.body.byteLength === 0) {
    throw new DocumentRejectedError("EMPTY", "the document is empty");
  }
  if (params.body.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentRejectedError(
      "TOO_LARGE",
      `documents must be under ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB`,
    );
  }

  const key = documentKey(params.userId, params.kind, params.contentType);

  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: params.body,
      ContentType: params.contentType,
      // Forces a download rather than inline rendering. Belt and braces
      // alongside the content-type allow-list against stored XSS.
      ContentDisposition: "attachment",
      Metadata: { userId: params.userId, kind: params.kind },
    }),
  );

  return { key, bytes: params.body.byteLength, contentType: params.contentType };
}

/**
 * A short-lived URL for a reviewer to open one document.
 *
 * Signed rather than public, and deliberately brief: these links end up in
 * browser history, support tickets and screenshots, so anything long-lived
 * becomes a permanent handle on somebody's passport.
 */
export async function signedDocumentUrl(
  key: string,
  ttlSeconds = SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  if (!key.startsWith("kyc/")) {
    // The key comes from our own database, but this stops a corrupted or
    // injected value reaching outside the KYC namespace.
    throw new Error("refusing to sign a key outside the kyc namespace");
  }
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: Math.min(ttlSeconds, 3600) },
  );
}

export async function documentExists(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Permanently removes a document.
 *
 * For data-subject erasure. Note this does NOT touch the kyc_records row: the
 * identity DIGEST and the verification decision are retained, because
 * self-exclusion and AML obligations outlive a deletion request. What goes is
 * the image, not the fact that verification happened.
 */
export async function deleteKycDocument(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
