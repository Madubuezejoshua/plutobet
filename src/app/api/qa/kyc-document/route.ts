import { NextResponse } from "next/server";
import { qaMethodNotAllowed, qaRoute } from "@/lib/api/qa-route";
import {
  readSignedReviewDocument,
  ReviewDocumentLinkError,
} from "@/modules/kyc/review-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves one KYC document from the disposable local store, for a signed link.
 *
 * The B2 path hands a reviewer a pre-signed S3 URL that expires in five
 * minutes. This is the same contract with a different signer: the link carries
 * an HMAC over key and expiry under the server's own secret, verified in
 * constant time before a byte is read. It would have been easier to accept a
 * bare key and read whatever was asked for, and that would have deleted the
 * control this whole path exists to demonstrate — an unguessable, short-lived
 * link is the actual protection around somebody's passport scan.
 *
 * `Content-Disposition: attachment` and `nosniff`, matching the real bucket
 * write: a document served inline is stored XSS with extra steps.
 */
export const GET = qaRoute("kyc-document", async (request) => {
  const params = new URL(request.url).searchParams;
  const key = params.get("key");
  const expires = params.get("expires");
  const signature = params.get("signature");
  if (!key || !expires || !signature) {
    return NextResponse.json({ error: "INCOMPLETE_LINK" }, { status: 400 });
  }

  try {
    const bytes = readSignedReviewDocument({ key, expires, signature });
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ReviewDocumentLinkError) {
      // One status for every failure. Distinguishing "expired" from "wrong
      // signature" from "no such key" tells a guesser which of the three they
      // got right, and none of the three is worth confirming.
      return NextResponse.json({ error: "LINK_NOT_VALID" }, { status: 403 });
    }
    throw error;
  }
});

/*
 * The verbs this route does not implement, answered through the SAME gate.
 * Without them Next replies 405 before any handler runs, and a 405 next to a
 * 404 tells a stranger the path exists — see `qaMethodNotAllowed`.
 */
export const POST = qaMethodNotAllowed("kyc-document");
export const PUT = qaMethodNotAllowed("kyc-document");
export const PATCH = qaMethodNotAllowed("kyc-document");
export const DELETE = qaMethodNotAllowed("kyc-document");
