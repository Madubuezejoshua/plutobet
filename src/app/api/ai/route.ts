import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { publicRoute, type RouteContext } from "@/lib/api/handler";
import { RATE_RULES } from "@/lib/api/rate-limit";
import { authOptions } from "@/modules/auth/auth-options";
import { aiProvider, SYSTEM_INSTRUCTIONS, toolsFor } from "@/modules/ai/provider";
import { runTool } from "@/modules/ai/runtime";
import { checkForCertaintyClaims } from "@/modules/ai/guardrails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(20),
  /**
   * The customer has confirmed THIS specific action.
   *
   * Sent only by the confirmation button, never carried forward from an earlier
   * turn — a customer who agreed to something two messages ago has not agreed
   * to whatever is proposed now.
   */
  confirmed: z.boolean().default(false),
});

/**
 * Pluto AI.
 *
 * The order below is the safety model, and it is deliberate:
 *
 *   1. Resolve who is asking, from the SESSION. Never from the request.
 *   2. Offer the model only the tools that caller may use.
 *   3. Run the tool through the guardrails, which re-check independently.
 *   4. Scan any generated prose for certainty claims before it is returned.
 *
 * The model influences step 2's outcome and nothing else. It cannot widen its
 * own permissions, name another customer, or complete a financial action.
 */
export const POST = publicRoute(
  "ai",
  RATE_RULES.ai,
  async ({ request }: RouteContext) => {
    const body = bodySchema.parse(await request.json());
    const session = await getServerSession(authOptions);

    // Identity comes from the session. A request that could name its own user
    // is a request that can read anybody's balance.
    const caller = {
      userId: session?.user.id ?? null,
      status: session?.user.status ?? null,
      confirmed: body.confirmed,
      // Step-up is a separate flow; nothing here can claim it.
      reauthenticated: false,
    };

    const provider = aiProvider();
    const response = await provider.respond({
      messages: body.messages,
      tools: toolsFor(Boolean(caller.userId)),
      systemInstructions: SYSTEM_INSTRUCTIONS,
    });

    let toolResult = null;
    if (response.toolCall) {
      toolResult = await runTool(response.toolCall.name, response.toolCall.arguments, caller);
    }

    /*
     * Last line of defence on generated prose (rule 15).
     *
     * The primary control is that probabilities come from the analysis service
     * with explicit confidence attached, so there is nothing to be certain
     * about. This catches a model that editorialised anyway — and refuses the
     * text rather than shipping it, because a customer who stakes their rent on
     * the word "guaranteed" has been actively harmed.
     */
    const generated = [response.text, toolResult?.summary].filter(Boolean).join("\n");
    const certainty = checkForCertaintyClaims(generated);
    if (!certainty.safe) {
      console.error("[ai] refused a response claiming certainty", certainty.matched);
      return NextResponse.json({
        text:
          "I cannot answer that the way I was about to — no outcome is guaranteed, and I will " +
          "not suggest otherwise. Ask me for the odds or the head-to-head instead.",
        model: provider.name,
        live: provider.live,
      });
    }

    return NextResponse.json({
      text: response.text || toolResult?.summary || "",
      tool: response.toolCall?.name ?? null,
      data: toolResult?.data ?? null,
      draft: toolResult?.draft ?? null,
      navigate: toolResult?.navigate ?? null,
      needsConfirmation: toolResult?.data?.code === "CONFIRMATION_REQUIRED",
      model: provider.name,
      live: provider.live,
    });
  },
);
