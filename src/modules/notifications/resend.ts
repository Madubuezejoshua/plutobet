import { DeliveryFailedError, type EmailProvider, type SendResult } from "./provider";

/**
 * Resend transactional email adapter.
 *
 * Field names follow Resend's published API; unverified against live traffic.
 */

const BASE = "https://api.resend.com";

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  constructor(
    private readonly apiKey: string,
    /** Must be a verified sending domain or Resend rejects the request. */
    private readonly from: string,
  ) {}

  async send(params: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<SendResult> {
    let response: Response;
    try {
      response = await fetch(`${BASE}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [params.to],
          subject: params.subject,
          text: params.text,
          ...(params.html ? { html: params.html } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new DeliveryFailedError(this.name, error instanceof Error ? error.message : "network error");
    }

    if (!response.ok) {
      throw new DeliveryFailedError(this.name, `HTTP ${response.status}`);
    }

    const payload = (await response.json().catch(() => null)) as { id?: string } | null;
    return { providerRef: payload?.id ?? null };
  }
}
