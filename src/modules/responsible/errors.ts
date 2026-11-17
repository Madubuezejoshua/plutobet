import type { RgLimitType } from "./schema";

/**
 * Responsible-gambling errors, deliberately in their own module.
 *
 * These are part of the module's public contract and are caught by the HTTP
 * layer, which must be able to import them WITHOUT pulling in the service —
 * the service imports the wallet, which opens the unpooled money-path client
 * at module load. Left in the service file, importing this error made a
 * public odds endpoint refuse to start without money credentials.
 */
export class RgViolationError extends Error {
  constructor(
    readonly limitType: RgLimitType | "SELF_EXCLUSION" | "COOL_OFF",
    message: string,
  ) {
    super(message);
    this.name = "RgViolationError";
  }
}
