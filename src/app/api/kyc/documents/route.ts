import { NextResponse } from "next/server";
import { z } from "zod";
import { authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { ApiError } from "@/lib/api/handler";
import { kycService } from "@/modules/kyc/kyc.service";
import type { KycDocumentKind } from "@/modules/kyc/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const kindSchema = z.enum(["ID_FRONT", "ID_BACK", "SELFIE", "PROOF_OF_ADDRESS"]);

/**
 * Uploads one supporting document for manual admin review.
 *
 * multipart/form-data rather than JSON+base64: a passport scan is a few MB,
 * and base64 costs a third more bytes over the wire for no benefit here.
 */
export const POST = authedRoute(
  "kyc",
  RATE_RULES.kyc,
  async ({ request, userId }: AuthedRouteContext) => {
    const form = await request.formData();
    const kind = kindSchema.parse(form.get("kind"));
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(422, "MISSING_FILE", "a file is required");
    }

    const body = new Uint8Array(await file.arrayBuffer());
    const result = await kycService.attachDocument({
      userId,
      kind: kind as KycDocumentKind,
      contentType: file.type,
      body,
    });

    return NextResponse.json({ documentKey: result.documentKey });
  },
);
