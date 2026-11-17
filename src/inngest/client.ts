import { Inngest } from "inngest";

/**
 * The Inngest client.
 *
 * WHY `isDev` IS SET EXPLICITLY
 * -----------------------------
 * The SDK picks cloud mode as soon as `INNGEST_SIGNING_KEY` is present. A
 * developer with real Inngest keys in their `.env` — which is the normal state
 * for anyone who has configured the deployment — therefore gets an app that
 * REFUSES to register with the local dev server:
 *
 *   app:     PUT /api/inngest -> "Cannot deploy localhost functions to
 *                                 production. Please use a forwarder."
 *   dev srv: "Expected server kind cloud, got dev", functionCount: 0
 *
 * Both processes start, both look healthy, and no function is registered. The
 * crons silently never fire — which is precisely the failure the heartbeat
 * table was added to expose, reappearing one layer further out. `npm run
 * dev:all` looked like it had fixed local scheduling and had not.
 *
 * OPT-IN, never inferred. Reading `NODE_ENV !== "production"` would be the
 * obvious shortcut and is the dangerous one: a staging or preview deployment
 * that happens not to set NODE_ENV would quietly drop into dev mode, stop
 * verifying request signatures, and accept unsigned calls to every scheduled
 * job. An explicit variable cannot be set by accident.
 */
export const inngest = new Inngest({
  id: "bet-platform",
  isDev: process.env.INNGEST_DEV === "1",
});
