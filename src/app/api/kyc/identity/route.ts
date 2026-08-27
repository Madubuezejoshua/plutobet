import { NextResponse } from "next/server";
import { z } from "zod";
import { authedRoute, type AuthedRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { kycService } from "@/modules/kyc/kyc.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    bvn: z.string().regex(/^\d{11}$/, "BVN must be exactly 11 digits").optional(),
    nin: z.string().regex(/^\d{11}$/, "NIN must be exactly 11 digits").optional(),
  })
  .refine((body) => body.bvn || body.nin, { message: "a BVN or a NIN is required" });

/**
 * Self-attested identity verification (tier 1).
 *
 * No automated lookup provider is wired up yet, so this grants tier 1 on the
 * strength of a well-formed, unique, non-excluded BVN/NIN alone — the same
 * bar every KYC-lite Nigerian fintech onboarding flow uses before a document
 * review. Tier 2 requires a human to look at an uploaded document; see
 * /api/kyc/documents.
 */
export const POST = authedRoute(
  "kyc",
  RATE_RULES.kyc,
  async ({ request, userId }: AuthedRouteContext) => {
    const body = bodySchema.parse(await request.json());

    const result = await kycService.verifyIdentity({
      userId,
      bvn: body.bvn,
      nin: body.nin,
      provider: "MANUAL",
      level: 1,
    });

    return NextResponse.json({ kycRecordId: result.kycRecordId, tier: 1 });
  },
);
