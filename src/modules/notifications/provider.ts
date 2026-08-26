/**
 * Vendor-agnostic delivery contracts.
 *
 * Nothing outside the adapters imports a Termii or Resend type, for the same
 * reason nothing outside the odds adapter imports an odds-api.io type: SMS
 * vendors in this market are swapped on price and deliverability, and that
 * should be one changed line.
 */

export interface SendResult {
  /** The vendor's own id, kept for delivery-report reconciliation. */
  providerRef: string | null;
}

export interface SmsProvider {
  readonly name: string;
  /** `to` is always E.164. Normalisation happens before this is called. */
  send(to: string, body: string): Promise<SendResult>;
}

export interface EmailProvider {
  readonly name: string;
  send(params: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<SendResult>;
}

export class DeliveryFailedError extends Error {
  constructor(
    readonly provider: string,
    readonly detail: string,
  ) {
    super(`${provider} delivery failed: ${detail}`);
    this.name = "DeliveryFailedError";
  }
}

/**
 * Used when no vendor is configured.
 *
 * Logs instead of sending, so local development and tests exercise the whole
 * OTP flow without spending money or requiring credentials. It is deliberately
 * NOT silent: a production deployment that reaches this has misconfigured its
 * keys, and the log line is how that gets noticed.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = "console";
  readonly sent: { to: string; body: string }[] = [];

  async send(to: string, body: string): Promise<SendResult> {
    this.sent.push({ to, body });
    console.warn(`[sms:console] no SMS provider configured — would send to ${to}`);
    return { providerRef: null };
  }
}

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  readonly sent: { to: string; subject: string }[] = [];

  async send(params: { to: string; subject: string; text: string }): Promise<SendResult> {
    this.sent.push({ to: params.to, subject: params.subject });
    console.warn(`[email:console] no email provider configured — would send to ${params.to}`);
    return { providerRef: null };
  }
}
