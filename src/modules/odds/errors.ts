/**
 * Provider errors the caller has to be able to tell apart.
 *
 * Everything upstream used to arrive as a bare `Error`, so a caller could only
 * choose between "give up entirely" and "swallow everything". Neither is right:
 * a rate limit is a reason to stop the whole run, and one deleted fixture is
 * not.
 */

/**
 * The provider does not know this event.
 *
 * A 404 for ONE event id. Distinct from a transport failure because it is
 * permanent and specific: the provider has forgotten the fixture — deleted,
 * merged into another, or expired out of its retention window.
 *
 * WHY THIS EXISTS
 * The result poller fetches each due event in turn. A single 404 threw out of
 * the whole loop, so a batch of twenty events returned nothing, the poll failed,
 * and NO bet on ANY event could settle. The heartbeat caught it on the very
 * first run the scheduler ever performed:
 *
 *   odds-api.io /events/72546036 -> 404 {"error":"Event not found"}
 *
 * and it would have repeated every minute forever, because the offending event
 * sorts to the head of the queue on each tick. One forgotten lower-league
 * fixture was enough to stop the entire sportsbook settling.
 */
export class ProviderEventNotFoundError extends Error {
  constructor(readonly providerEventId: string) {
    super(`provider does not know event ${providerEventId}`);
    this.name = "ProviderEventNotFoundError";
  }
}

/**
 * A BATCH the provider refused because some of the ids in it are unknown.
 *
 * `/odds/multi` answers `400 {"error":"One or more eventIds not found: ..."}`
 * and names the offenders. The same failure as above, one level up: a single
 * stale id in a chunk of forty threw, and the throw escaped the chunk loop, so
 * a whole odds refresh returned nothing.
 *
 * This is why the board had fixtures with no prices on them. Events stay in our
 * table after the provider drops them, every refresh included at least one such
 * id, and every refresh failed — so no upcoming fixture was ever priced and
 * nobody could bet on anything.
 *
 * The named ids are carried so the caller can drop exactly those and retry with
 * the rest, rather than discarding good ids along with the bad.
 */
export class ProviderUnknownEventsError extends Error {
  constructor(readonly unknownEventIds: string[]) {
    super(`provider rejected ${unknownEventIds.length} unknown event id(s)`);
    this.name = "ProviderUnknownEventsError";
  }
}

/**
 * Pulls the offending ids out of the provider's 400 body.
 *
 * Returns an empty array when the body is not that shape, so an unrelated 400
 * keeps its normal fatal handling — a parse that guesses would silently turn
 * every bad request into "retry without some ids".
 */
export function parseUnknownEventIds(body: string): string[] {
  const match = /eventIds? not found:\s*([0-9A-Za-z_,\s-]+)/i.exec(body);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
