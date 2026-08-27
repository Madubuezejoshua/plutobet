import { NextResponse } from "next/server";
import { z } from "zod";
import { adminRoute, type AdminRouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { kycService } from "@/modules/kyc/kyc.service";
import { requirePermission } from "@/modules/admin/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  kycRecordId: z.string().uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(500).optional(),
});

/** Admin decision on one uploaded KYC document. */
export const POST = adminRoute(
  "admin",
  RATE_RULES.admin,
  async ({ request, adminUserId }: AdminRouteContext) => {
    // `adminRoute` establishes that this is an administrator; this establishes
    // that they are one allowed to make KYC decisions. A support agent must
    // not be able to approve a document by calling the API directly.
    await requirePermission("kyc.review");

    const body = bodySchema.parse(await request.json());

    const result = await kycService.reviewDocument({
      kycRecordId: body.kycRecordId,
      reviewerId: adminUserId,
      decision: body.decision,
      note: body.note,
    });

    return NextResponse.json({ userId: result.userId, decision: body.decision });
  },
);
