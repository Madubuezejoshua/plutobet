import { describe, expect, it } from "vitest";
import { parseUnknownEventIds, ProviderUnknownEventsError } from "../errors";

/**
 * Surviving ids the provider has forgotten.
 *
 * Both halves of this were found by running the scheduler for the first time
 * rather than by reading the code. The provider drops events we still hold, so
 * every batch call eventually contains a stale id, and both batch endpoints
 * failed whole:
 *
 *   /events/{id}  -> 404 Event not found              (results poll)
 *   /odds/multi   -> 400 One or more eventIds not found (price refresh)
 *
 * The first stopped every bet settling. The second is why upcoming fixtures sat
 * on the board with no prices at all — nobody could place a bet, and the board
 * looked simply empty rather than broken.
 */
describe("parsing the provider's unknown-id rejection", () => {
  it("extracts a single id", () => {
    // The exact body observed in the dev log.
    expect(
      parseUnknownEventIds('{"error":"One or more eventIds not found: 31361425957"}'),
    ).toEqual(["31361425957"]);
  });

  it("extracts several ids", () => {
    expect(
      parseUnknownEventIds('{"error":"One or more eventIds not found: 111, 222,333"}'),
    ).toEqual(["111", "222", "333"]);
  });

  it("returns nothing for an unrelated 400, so it stays fatal", () => {
    // A parse that guessed would turn every malformed request into a silent
    // partial success — the request would be narrowed until it stopped failing.
    expect(parseUnknownEventIds('{"error":"Missing bookmaker parameter"}')).toEqual([]);
    expect(parseUnknownEventIds("Bad Request")).toEqual([]);
    expect(parseUnknownEventIds("")).toEqual([]);
  });

  it("carries the offending ids so the caller can drop exactly those", () => {
    const error = new ProviderUnknownEventsError(["a1", "b2"]);
    expect(error.unknownEventIds).toEqual(["a1", "b2"]);
    expect(error.name).toBe("ProviderUnknownEventsError");
    // The message must not imply the whole batch was bad.
    expect(error.message).toMatch(/2 unknown event id/);
  });
});
