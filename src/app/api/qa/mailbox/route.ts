import { NextResponse } from "next/server";
import { qaMethodNotAllowed, qaRoute } from "@/lib/api/qa-route";
import { codeIn, latestMessageFor } from "@/modules/notifications/review-mailbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reads the local mailbox a review server delivers one-time codes into.
 *
 * THIS IS THE HALF THAT KEEPS THE OTHER HALF HONEST. The point of a one-time
 * code is that it travels by a channel the requester does not control, and the
 * console fallback destroyed that property by handing the code back in the
 * response — which is why `otp.service` refuses it under a production build.
 * The mailbox restores the property: the code goes somewhere else, and getting
 * it back requires the review key, which a customer on the same server does not
 * have. A browser test therefore performs the same two steps a real person
 * does, and an attacker on a real deployment can perform neither.
 *
 * `qaRoute` answers 404 unless all four review-environment conditions hold AND
 * the caller presents `x-plutobet-review-key`.
 */
export const GET = qaRoute("mailbox", async (request) => {
  const destination = new URL(request.url).searchParams.get("destination");
  if (!destination) {
    return NextResponse.json({ error: "destination is required" }, { status: 422 });
  }

  const message = latestMessageFor(destination);
  if (!message) return NextResponse.json({ found: false }, { status: 404 });

  return NextResponse.json({
    found: true,
    channel: message.channel,
    destination: message.destination,
    subject: message.subject,
    at: message.at,
    code: codeIn(message),
  });
});

/*
 * The verbs this route does not implement, answered through the SAME gate.
 * Without them Next replies 405 before any handler runs, and a 405 next to a
 * 404 tells a stranger the path exists — see `qaMethodNotAllowed`.
 */
export const POST = qaMethodNotAllowed("mailbox");
export const PUT = qaMethodNotAllowed("mailbox");
export const PATCH = qaMethodNotAllowed("mailbox");
export const DELETE = qaMethodNotAllowed("mailbox");
