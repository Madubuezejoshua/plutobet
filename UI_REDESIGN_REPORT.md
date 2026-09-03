# PlutoBet — Interface redesign

**Branch:** `ui/plutobet-sportsbook-redesign`
**Merged:** no. **Deployed:** no. **Waiting on:** visual review of the
screenshots named in §8.
**Date:** 2026-09-02

For the state of the platform as a whole, read [`general.md`](general.md). This
document is the detail of one pass.

No credential, connection string, one-time code or personal detail appears here.

---

## 1. What was asked, and what was done

A complete redesign of the customer-facing interface, using a competitor
screenshot as a **structural** reference — dense match listings, league
navigation, market columns, a sticky betslip — and copying none of its logo,
assets, colours, text, banners or proprietary visual design.

Alongside it: make every visible control functional, or make it honestly say it
is not.

Explicitly out of scope, and untouched: wallet accounting, the ledger, bet
placement, settlement, locked odds, exposure, provider ingestion, the database
schema, payment logic, RBAC, authentication validation, API response contracts,
idempotency and the existing security controls.

**One server-side addition was necessary:** `getEventView` in
`src/modules/odds/odds.service.ts`, a read-only query returning one fixture with
its open markets. The match board already linked to `/sports/event/<id>` from two
controls on every row and that page did not exist. Building it needed a read that
returns all markets for one event rather than the three the board shows. It calls
no provider, prices no bet and writes nothing.

---

## 2. The structure, and why

```
┌───────────────────────────────────────────────────────────────┐
│  header: brand · destinations · search · balance · deposit    │  dark
│  sub-header: sports                                           │  dark
├───────────┬───────────────────────────────────┬───────────────┤
│ league    │  filters                          │  betslip      │
│ rail      │  league-grouped match board       │  (sticky)     │
│ (sticky)  │  1 X 2 · O/U 2.5 · all markets    │               │
└───────────┴───────────────────────────────────┴───────────────┘
```

| Decision | Reason |
|---|---|
| The homepage **is** the board | It opened with a marketing hero and a grid of product tiles, most of which linked to products that do not exist. A customer arriving to place a bet scrolled past all of it before seeing a price |
| Dark chrome, light canvas | The previous system was dark everywhere. A dense list of odds is far more scannable on white; the chrome stays dark so the brand still reads as a betting product |
| Two header rows | Seventeen products in one row overflowed horizontally on anything narrower than a desktop. Destinations on the first row, sports on the second, where a horizontal scroll is expected |
| Betslip on the right, sheet on mobile | Losing the board behind a full page navigation is what makes mobile betting feel slow |
| League grouping with counts | The unit a customer browses in is a competition, not a flat list of kick-off times |
| Odds tiles carry state in `data-state` | A price has nine states. Expressing those as class strings inside JSX makes them impossible to review side by side |

---

## 3. What was removed, and why

| Removed | Reason |
|---|---|
| **"Nigeria · Licensed operator"** in the footer | A licence claim is a regulatory assertion, not decoration. There is no licence. Publishing one before it exists is the kind of claim that ends an application |
| **"arrives in phase 13"** on every unbuilt product | An internal build-phase number means nothing to a customer and reads as a delivery commitment nobody made |
| **Emoji navigation icons** | They render differently on every platform, several are unreadable at 16px on a cheap Android screen, and a screen reader announces the emoji's CLDR name rather than the product's |
| **The "Soon" tag on Results and Livescore** | Both work. Labelling a working page as unbuilt is the same class of error as the reverse: either way the customer cannot trust the navigation |
| **The old customer chrome** — `masthead.tsx`, `bottom-bar.tsx`, `site-shell.tsx`, `site-footer.tsx`, `sports/bet-slip.tsx` | Replaced, and left in the tree they would have been a second, divergent implementation of the same screens |

---

## 4. Every dead control found, and what it is now

A control that looks like it works and does not is worse than no control. Seven
were found.

| Was | Now |
|---|---|
| Board rows linked to `/sports/event/<id>` from a statistics icon and a "+N" chip. **The route did not exist** — two 404s on every row of the most-used screen | The event page exists, listing every open market on the fixture, each tile adding to the betslip |
| The header search linked to `/sports?focus=search`, which nothing read | A real search: it filters the board by team or competition, is a query parameter so it can be bookmarked, and an empty query is a no-op rather than a pointless navigation |
| League and fixture stars toggled a colour and forgot it on the next navigation | Both persist per browser and pin what they mark to the top of the rail and the top of the board |
| After a password reset, "Sign in" called `signIn("credentials", { email })` **with no password** — a call that can only fail, at the moment the customer had just succeeded | A link to the sign-in form |
| Casino tiles linked to `/casino/play/<id>`, which does not exist; the only configured provider is the development sandbox, whose own launch URL deliberately returns an explainer rather than a game | Non-linking cards, with the page stating plainly that the games cannot be opened yet and why |
| The "+0" chip on a fixture with no extra markets | A chevron to the event page. "+0" reads as a broken counter, not as "no other markets" |
| The referral link was printed as text for the customer to select by hand on a phone | Copy and Share buttons, the second offered only where `navigator.share` exists |

Deliberately inert, and saying so: live prices (in-play placement needs a real
feed), casino games (no aggregator), cash-out (§6), and the three unbuilt
products.

---

## 5. Three things this pass found in its own work

### The entire redesign was invisible, and every gate passed

`src/app/globals.css` imported the four sportsbook stylesheets **below**
Tailwind's `@source` directive. CSS requires `@import` to precede every other
rule except `@charset` and `@layer`; `@source` is neither, so all four imports
were invalid and were dropped.

`tsc` was clean, `eslint` was clean, every test passed and `next build` exited 0,
because none of those tools reads CSS ordering. The only symptom was the first
screenshot: unstyled HTML.

Fixed by moving the imports above `@source`, with the reason written beside
them. A regression test — `src/lib/__tests__/stylesheet-imports.acceptance.spec.ts`
— now fails if any `@import` in that file sits after a rule that ends the import
block, because a rule invisible to every other gate needs a gate of its own.

### Four responsive rules were losing on source order

The stylesheet had a systemic problem, and it produced no error anywhere.

| Rule | Lost to | Effect |
|---|---|---|
| `.sb-row__ou { display: none }` | `.sb-odd { display: flex }`, declared later | the Over/Under columns would not have hidden on a phone |
| `--sb-boardcols` overridden inside a media query | the unconditional `.sb-board` declaration, which a minifier may emit last | the responsive column template would not have applied |
| `.sb-fixture__stats { display: none }` | `.sb-pick__x`, declared later | the duplicate statistics icon would have stayed |
| `.sb-odd__more { min-width: 0 }` | its own base rule's `min-width: 40px` | the chip overhung its track by ten pixels |

All four are equal-specificity conflicts resolved by source order, and in every
case the losing rule was the one inside the media query. Each now carries a
parent selector — `.sb-odd.sb-row__ou`, `.sb-board .sb-row`,
`.sb-fixture .sb-fixture__stats`, `.sb-board .sb-odd__more` — so it wins
regardless of the order a bundler emits. The reasoning is written into the
stylesheet beside them.

### And a measurement error, which is the most useful of the three

The first "mobile" screenshots showed the board overflowing badly. It was
tempting, and wrong, to read that as a fourth CSS defect.

Chrome's one-shot `--headless --window-size=390,900 --screenshot` sets the
**capture** size, not the layout viewport. The page inside those images was laid
out at roughly 880px and cropped to 390 — so every mobile screenshot was a
desktop layout with two thirds cut off, and it looked exactly like a responsive
bug. An hour went into chasing a layout problem that did not exist.

`scripts/capture-ui-screenshots.mjs` now drives Chrome over DevTools and calls
`Emulation.setDeviceMetricsOverride`, which sets the viewport for real. A 390px
screenshot is now a 390px page.

**The four CSS conflicts above are real** — they were each confirmed by reading
the cascade, not by looking at those images — but the dramatic overflow that
prompted the hunt was an artefact of the tool. Both facts belong in the record.

---

## 6. Cash-out: examined, and deliberately not shipped

The instruction was to add an authenticated route and UI **only** if every money
invariant was complete, and otherwise to record the defect.

`cashout.service.ts` is well built: the offer is re-priced under the bet's row
lock rather than trusting a quoted figure, a lower re-price is refused so the
customer is never paid less than they accepted, a higher one is paid in full, the
lock order matches placement and settlement, and settlement already pays only on
the stake still at risk.

**One invariant does not hold.** A partial cash-out releases a proportional slice
of the market's liability, and settlement later releases the full
`potential_return − stake` again — so the liability is released twice for the
portion already bought back. It floors at zero rather than going negative, which
means a market can read as carrying no exposure while other bets on it still do.

**And one gate is missing.** The service does not check account status, so a
route would have to add the suspended / self-excluded / closed check itself.

Neither misplaces money — exposure is a risk ceiling, not a balance. Both are
money-adjacent, the instruction was "every invariant", and it is not every
invariant. No control was added. The detail is in [`general.md`](general.md) §15.

---

## 7. Verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 15 pre-existing warnings |
| `npx vitest run` | 68 files, 844 passed, 1 skipped, 0 failed |
| `npx next build` | exit 0 — every route emitted, including `/signin` and `/sports/event/[id]` |
| `node scripts/secret-scan.mjs` | clean |
| `git diff --check` | clean |

**Tests added (29):**

| File | Covers |
|---|---|
| `src/components/sportsbook/__tests__/slip-math.acceptance.spec.ts` | Stake parsing to integer kobo, and that the gross return and the profit differ by exactly the stake |
| `src/lib/__tests__/safe-redirect.acceptance.spec.ts` | The sign-in open-redirect guard against another origin, protocol-relative, backslash, non-rooted and control-character callbacks |
| `src/lib/__tests__/navigation.acceptance.spec.ts` | Every registry entry routes to a page that exists; no build-phase numbers; no emoji; sign-in points at the branded page |
| `src/lib/__tests__/stylesheet-imports.acceptance.spec.ts` | The `@import` ordering defect in §5 |

**No existing test was weakened, skipped or deleted.** The vitest `include`
pattern was widened from `src/modules/**` to also collect `src/lib/**` and
`src/components/**`, which adds files rather than removing any.

---

## 8. Screenshots

Captured against a **local disposable database** seeded with
`npm run db:seed-demo` — five clearly-named demo fixtures. **Not** against
production, and **not** against the 400 synthetic benchmark fixtures.

```bash
npx tsx scripts/dev-stack.ts                        # local Postgres + Redis
npm run db:seed-demo
npx next build && npx next start -p 3100            # with the local database URLs
node scripts/capture-ui-screenshots.mjs --base=http://localhost:3100
```

Output: `artifacts/ui-review/` — desktop at 1440×1000 and mobile at 390×900, one
pair per page. The directory is git-ignored: a screenshot goes stale the moment
the interface changes, and a binary nobody diffs does not belong in history.

---

## 9. What is deliberately still legacy

`src/styles/legacy-bridge.css` re-points the old design system's variables at
the new tokens, scoped to the `.sb` shell, so pages still carrying legacy classes
render in the new palette without a find-and-replace across the deposit,
withdrawal, KYC and safer-gambling forms — which is exactly the code where a
careless replacement does real damage.

It is a migration aid with an end date: **delete it when no page inside `.sb`
uses a legacy class.** The forms still carrying them are `kyc-form`,
`responsible/controls`, `account/preferences`, `account/security`,
`account/verify-email` and `pluto-chat`.

The admin console is untouched and keeps the dark system. It renders outside the
`.sb` shell, it is an internal tool, and re-skinning it here would have been an
unreviewed change to screens that approve withdrawals.

---

## 10. Not merged

Nothing in this pass has been merged to `main` or deployed. The branch is
`ui/plutobet-sportsbook-redesign`.

Review the screenshots in `artifacts/ui-review/`, then decide.
