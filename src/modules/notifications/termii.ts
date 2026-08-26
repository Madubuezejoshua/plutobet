import { DeliveryFailedError, type SendResult, type SmsProvider } from "./provider";

/**
 * Termii SMS adapter.
 *
 * Chosen over Twilio for this market on price — Nigerian routes are a large
 * multiple cheaper, and OTP volume is the dominant messaging cost of a
 * betting platform.
 *
 * NOTE: the request/response shape below follows Termii's published API and
 * has NOT been checked against live traffic. Treat it the way the odds
 * adapter is treated until a real send has been observed.
 */

const BASE = "https://api.ng.termii.com/api";

type TermiiResponse = {
  message_id?: string;
  message?: string;
  code?: string;
};

export class TermiiSmsProvider implements SmsProvider {
  readonly name = "termii";

  constructor(
    private readonly apiKey: string,
    /** Registered sender ID. Unregistered IDs are silently dropped by NCC. */
    private readonly senderId: string,
  ) {}

  async send(to: string, body: string): Promise<SendResult> {
    // Termii wants the number without the leading plus.
    const recipient = to.replace(/^\+/, "");

    let response: Response;
    try {
      response = await fetch(`${BASE}/sms/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: recipient,
          from: this.senderId,
          sms: body,
          type: "plain",
          channel: "generic",
          api_key: this.apiKey,
        }),
        // An OTP that arrives after the user gives up is worse than a fast
        // failure they can retry.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new DeliveryFailedError(this.name, error instanceof Error ? error.message : "network error");
    }

    const payload = (await response.json().catch(() => null)) as TermiiResponse | null;

    if (!response.ok) {
      // Deliberately does not include the response body: it echoes the
      // message, and for an OTP the message contains the code.
      throw new DeliveryFailedError(this.name, `HTTP ${response.status}`);
    }
    if (!payload?.message_id) {
      throw new DeliveryFailedError(this.name, payload?.message ?? "no message id returned");
    }

    return { providerRef: payload.message_id };
  }
}
