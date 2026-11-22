import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    try {
      const { startBackgroundOddsSync } = await import("@/modules/odds/multi-sport-sync");
      startBackgroundOddsSync();
    } catch (error) {
      console.error("[instrumentation] failed to start background odds sync", error);
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
