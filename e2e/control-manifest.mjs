/**
 * The expected-control manifest.
 *
 * WHY A MANIFEST AT ALL. The interaction audit is generated from what the
 * browser did, which makes every row in it true — and says nothing about what
 * was never attempted. A generated report cannot tell you about the control
 * nobody wrote a test for. This file is the other half: a declared list of what
 * MUST be accounted for, so that "we tested everything we tested" becomes
 * "we tested everything we said existed".
 *
 * `scripts/check-control-coverage.mjs` compares this against the audit rows and
 * fails when a control marked `browser` has none.
 *
 * HOW TO ADD A CONTROL. Add the row here first. The check will fail, and that
 * failure is the point: it is the reminder to write the test. Deleting a row to
 * make the check pass is the one edit that defeats the whole file.
 *
 * COVERAGE KINDS
 *
 *   browser               must be clicked or submitted in a real browser
 *   blocked               the underlying feature needs a key, contract,
 *                         product decision or licence; the control is expected
 *                         to be absent, disabled, or to render an honest
 *                         unavailable state
 *   integration-boundary  cannot meaningfully exist in a browser, and is
 *                         covered by an integration test that is NAMED
 *   hidden                deliberately not rendered, because the feature does
 *                         not exist
 *
 * ============================================================================
 * THE REASON CODES, AND WHY THEY ARE A CLOSED LIST
 * ============================================================================
 *
 * The previous version of this file required a `why` and accepted any prose.
 * That is exactly enough rigour to be defeated by a sentence, and it was: five
 * controls were classified as integration boundaries whose reason was, in
 * substance, "pressing this would break the rest of the run". Self-exclusion,
 * a cool-off, a password change, revoking a session, a KYC upload — all of them
 * irreversible for the account that performs them, all of them perfectly
 * testable on an account created three seconds earlier. That is a shared-
 * fixture problem, not an integration boundary, and a free-text field let it
 * wear the costume.
 *
 * So the reason is now a CODE from this list, and the checker enforces both
 * membership and the prose that must accompany it:
 *
 *   EXTERNAL_PROVIDER_KEY_REQUIRED
 *       A purchased credential is missing. Nobody can exercise the real
 *       behaviour without it, and a fixture standing in for it would be a
 *       fiction. The control renders an honest unavailable state.
 *
 *   COMMERCIAL_CONTRACT_REQUIRED
 *       A signed agreement with a third party is missing.
 *
 *   PRODUCT_DECISION_REQUIRED
 *       The owner has not defined the rule. Implementing one to make a test
 *       pass would invent a financial or product policy nobody agreed to.
 *
 *   REGULATION_REQUIRED
 *       A licence, certification or approval is missing.
 *
 *   TIME_BASED_COVERED_BY_DETERMINISTIC_INTEGRATION_TEST
 *       The behaviour happens after a delay a browser cannot wait out — a
 *       24-hour limit increase, a backoff schedule. The named test controls
 *       the clock. `why` MUST name the spec file.
 *
 *   IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT
 *       The action cannot be undone for whoever performs it, and it IS
 *       performed — on an account created for that test alone. Used on
 *       `browser` rows, as a record of how the coverage was obtained, so that
 *       "it would break the suite" can never again be mistaken for a reason
 *       not to press something.
 *
 *   NON_VISUAL_INTERNAL_INVARIANT
 *       The property is not observable on screen at all: a combinatorial
 *       expansion, a lock ordering, a construction-time refusal, a lockfile
 *       audit. `why` MUST name the spec file that asserts it.
 *
 * A row whose reason does not appear here, or whose prose reads as
 * "the shared demo account would be inconvenient", is REFUSED by the checker.
 */

/**
 * @typedef {"EXTERNAL_PROVIDER_KEY_REQUIRED"
 *   | "COMMERCIAL_CONTRACT_REQUIRED"
 *   | "PRODUCT_DECISION_REQUIRED"
 *   | "REGULATION_REQUIRED"
 *   | "TIME_BASED_COVERED_BY_DETERMINISTIC_INTEGRATION_TEST"
 *   | "IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT"
 *   | "NON_VISUAL_INTERNAL_INVARIANT"} ControlReason
 */

/** Every reason a non-browser row may give. The checker enforces membership. */
export const CONTROL_REASONS = [
  "EXTERNAL_PROVIDER_KEY_REQUIRED",
  "COMMERCIAL_CONTRACT_REQUIRED",
  "PRODUCT_DECISION_REQUIRED",
  "REGULATION_REQUIRED",
  "TIME_BASED_COVERED_BY_DETERMINISTIC_INTEGRATION_TEST",
  "IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT",
  "NON_VISUAL_INTERNAL_INVARIANT",
];

/**
 * Reasons that only make sense on a control that IS covered in a browser.
 *
 * A row claiming an irreversible action was tested on a disposable account, and
 * then not appearing in the audit, is claiming the opposite of what it says.
 */
export const BROWSER_ONLY_REASONS = ["IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT"];

/** Reasons whose prose must name the spec file that carries the coverage. */
export const REASONS_REQUIRING_A_NAMED_TEST = [
  "TIME_BASED_COVERED_BY_DETERMINISTIC_INTEGRATION_TEST",
  "NON_VISUAL_INTERNAL_INVARIANT",
];

/** @typedef {{page: string, control: string, coverage: "browser"|"blocked"|"integration-boundary"|"hidden", reason?: ControlReason, why?: string}} ExpectedControl */

/** @type {ExpectedControl[]} */
export const CONTROL_MANIFEST = [
  // ------------------------------------------------------------ global chrome
  { page: "any", control: "Brand mark", coverage: "browser" },
  { page: "any", control: "Primary navigation", coverage: "browser" },
  { page: "any", control: "Sports sub-navigation", coverage: "browser" },
  { page: "any", control: "More menu", coverage: "browser" },
  { page: "any", control: "More menu — Escape closes", coverage: "browser" },
  { page: "any", control: "More menu — outside click closes", coverage: "browser" },
  { page: "any", control: "Pluto AI navigation", coverage: "browser" },
  { page: "any", control: "Balance", coverage: "browser" },
  { page: "any", control: "Deposit", coverage: "browser" },
  { page: "any", control: "Account", coverage: "browser" },
  { page: "any", control: "Sign in link", coverage: "browser" },
  { page: "any", control: "Register link", coverage: "browser" },
  { page: "footer", control: "14 links", coverage: "browser" },
  { page: "/api/health", control: "health endpoint", coverage: "browser" },
  { page: "/not-a-real-page", control: "404 recovery links", coverage: "browser" },
  { page: "any", control: "Mobile navigation", coverage: "browser" },

  // -------------------------------------------------------------------- board
  { page: "/", control: "Header search", coverage: "browser" },
  { page: "/", control: "Competition search", coverage: "browser" },
  { page: "/", control: "Date filter chips", coverage: "browser" },
  { page: "/", control: "League filter", coverage: "browser" },
  { page: "/", control: "League collapse", coverage: "browser" },
  { page: "/", control: "Country collapse", coverage: "browser" },
  /*
   * ONE entry, not two. This listed both "Competition favourite (star)" and
   * "Competition favourite" — the same control under two names, because two
   * specs had recorded it differently. Only the desktop spec used the "(star)"
   * form, so the gate reported a mobile gap for a control mobile does not
   * render at all: the rail is hidden below 900px by design, and the audit says
   * so in its own row.
   */
  { page: "/", control: "Competition favourite", coverage: "browser" },
  { page: "/", control: "Fixture favourite", coverage: "browser" },
  { page: "/", control: "Favourite cross-tab sync", coverage: "browser" },
  { page: "/", control: "Odds tile", coverage: "browser" },
  { page: "/", control: "Unavailable odds state", coverage: "browser" },
  { page: "/", control: "More markets chevron", coverage: "browser" },
  { page: "/", control: "Statistics link", coverage: "browser" },
  { page: "/", control: "Betslip persistence", coverage: "browser" },

  // ------------------------------------------------------------- event detail
  { page: "/sports/event", control: "Market collapse", coverage: "browser" },
  { page: "/sports/event", control: "Selection adds to betslip", coverage: "browser" },
  { page: "/sports/event", control: "Back to competition", coverage: "browser" },

  // ----------------------------------------------------------------- betslip
  { page: "/", control: "Betslip empty state", coverage: "browser" },
  { page: "/", control: "Betslip remove selection", coverage: "browser" },
  { page: "/", control: "Betslip clear all", coverage: "browser" },
  { page: "/", control: "Betslip stake field", coverage: "browser" },
  { page: "/", control: "Betslip quick stake", coverage: "browser" },
  { page: "/", control: "Betslip invalid stake", coverage: "browser" },
  { page: "/", control: "Betslip potential return", coverage: "browser" },
  { page: "/", control: "Betslip accumulator", coverage: "browser" },
  { page: "/", control: "Betslip signed-out prompt", coverage: "browser" },
  { page: "/", control: "Place bet", coverage: "browser" },
  { page: "/", control: "Place bet — duplicate submit", coverage: "browser" },
  { page: "/", control: "Place bet — insufficient funds", coverage: "browser" },
  { page: "/", control: "Mobile betslip sheet", coverage: "browser" },
  {
    page: "/",
    control: "Betslip system bet and bankers",
    coverage: "integration-boundary",
    reason: "NON_VISUAL_INTERNAL_INVARIANT",
    why: "a browser can place ONE system bet; what cannot be seen on screen is that every one of the C(n,k) combinations is priced, staked and refused independently, and that a partial placement charges only what landed. slip-math.acceptance.spec.ts covers the whole expansion and http-placement.acceptance.spec.ts the partial charge",
  },
  { page: "/", control: "Stale price refusal", coverage: "browser" },
  { page: "/", control: "Odds-moved warning", coverage: "browser" },
  { page: "/", control: "Odds-moved confirmation", coverage: "browser" },
  { page: "/", control: "Suspended selection refusal", coverage: "browser" },
  { page: "/", control: "Closed or suspended market refusal", coverage: "browser" },
  { page: "/", control: "Betslip / My Bets tabs", coverage: "browser" },

  // ---------------------------------------------------------- authentication
  { page: "/signin", control: "Sign in (wrong password)", coverage: "browser" },
  { page: "/signin", control: "Sign in (correct password)", coverage: "browser" },
  { page: "/signin", control: "Show/hide password", coverage: "browser" },
  { page: "/signin", control: "Forgot password link", coverage: "browser" },
  { page: "/signin", control: "Unsafe callback rejected", coverage: "browser" },
  { page: "/register", control: "Date of birth", coverage: "browser" },
  { page: "/register", control: "Registration (adult)", coverage: "browser" },
  { page: "/register", control: "Registration (duplicate)", coverage: "browser" },
  { page: "/register", control: "Change details", coverage: "browser" },
  { page: "/register", control: "Registration after exclusion", coverage: "browser" },
  { page: "/forgot-password", control: "Password reset request", coverage: "browser" },
  { page: "any", control: "Sign out", coverage: "browser" },
  {
    page: "/register",
    control: "OTP delivery",
    coverage: "browser",
    why: "the code is issued, delivered out of band to the local review mailbox, read back through a keyed route the browser session cannot reach, and verified. What is NOT proven is that Termii delivers an SMS to a real handset, and that is never claimed anywhere",
  },
  {
    page: "any",
    control: "Session revocation refresh",
    coverage: "browser",
    reason: "IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT",
    why: "the same account is signed in from two real browser contexts, one revokes the other, and the revoked context's NEXT request is watched being refused. Previously excluded on the grounds that a browser can only observe the effect one request later — which IS the control, and is what the customer who pressed the button is buying",
  },
  {
    page: "/forgot-password",
    control: "Password reset completed",
    coverage: "browser",
    reason: "IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT",
    why: "a completed reset signs every device out and invalidates the old password, so it runs on an account created for that test alone; both the old and the new password are then tried at the sign-in form",
  },

  // --------------------------------------------- account and safer gambling
  { page: "/account", control: "Account tiles", coverage: "browser" },
  { page: "/account/security", control: "Change password", coverage: "browser" },
  {
    page: "/account/security",
    control: "Change password — accepted",
    coverage: "browser",
    reason: "IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT",
    why: "a successful change signs every OTHER device out, so it runs on a disposable account; the new password is then used to sign in from a cleared browser context",
  },
  { page: "/account/security", control: "Sign out other devices", coverage: "browser" },
  { page: "/account/preferences", control: "Odds format preference", coverage: "browser" },
  { page: "/account/preferences", control: "Notification preference", coverage: "browser" },
  { page: "/responsible", control: "Set a deposit limit", coverage: "browser" },
  { page: "/responsible", control: "Set a stake limit", coverage: "browser" },
  { page: "/responsible", control: "Set a loss limit", coverage: "browser" },
  { page: "/responsible", control: "Cool-off", coverage: "browser" },
  { page: "/referrals", control: "Referral copy", coverage: "browser" },
  { page: "/rewards", control: "Rewards navigation", coverage: "browser" },
  { page: "/account/date-of-birth", control: "Date-of-birth completion", coverage: "browser" },
  { page: "/account/date-of-birth", control: "Date-of-birth underage refusal", coverage: "browser" },
  {
    page: "/responsible",
    control: "Self-exclusion",
    coverage: "browser",
    reason: "IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT",
    why: "taken for real, on an account created for that test with a verified identity on file. It was previously excluded on grounds that described one particular fixture rather than any property of the control — a fixture problem, not an integration boundary, and the answer to a fixture problem is a different fixture",
  },
  { page: "/responsible", control: "Self-exclusion blocks wagering", coverage: "browser" },
  { page: "/responsible", control: "Self-exclusion survives re-registration", coverage: "browser" },
  {
    page: "/responsible",
    control: "Cool-off blocks wagering",
    coverage: "browser",
    reason: "IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT",
    why: "a break cannot be shortened once started, so it runs on a disposable funded account that places a bet before it and is refused after it, with the refusal's wording asserted",
  },
  {
    page: "/responsible",
    control: "Delayed limit increase",
    coverage: "integration-boundary",
    reason: "TIME_BASED_COVERED_BY_DETERMINISTIC_INTEGRATION_TEST",
    why: "a raised limit takes effect 24 hours later and a browser cannot wait; responsible.acceptance.spec.ts controls the clock. The browser DOES assert that the increase is shown as scheduled rather than applied",
  },
  {
    page: "/account",
    control: "Email verification request",
    coverage: "blocked",
    reason: "EXTERNAL_PROVIDER_KEY_REQUIRED",
    why: "Resend. The route is exercised in the browser, and the review mailbox proves the SAME delivery path end to end for password reset; that a real email reaches a real inbox is not exercised and is never claimed",
  },

  // ------------------------------------------------------------ wallet & KYC
  { page: "/wallet", control: "Wallet page", coverage: "browser" },
  { page: "/wallet", control: "Wallet buckets", coverage: "browser" },
  { page: "/withdraw", control: "Bank field", coverage: "browser" },
  { page: "/withdraw", control: "Account name resolution", coverage: "browser" },
  {
    page: "/withdraw",
    control: "Account name is never taken from the browser",
    coverage: "browser",
  },
  { page: "/withdraw", control: "Account resolution refusals", coverage: "browser" },
  { page: "/withdraw", control: "Withdrawal minimum refused", coverage: "browser" },
  { page: "/withdraw", control: "Over-balance withdrawal refused", coverage: "browser" },
  { page: "/kyc", control: "KYC status", coverage: "browser" },
  { page: "/deposit", control: "Deposit page", coverage: "browser" },
  {
    page: "/kyc",
    control: "KYC upload",
    coverage: "browser",
    reason: "IRREVERSIBLE_ACTION_TESTED_WITH_ISOLATED_DISPOSABLE_ACCOUNT",
    why: "an identity submission cannot be withdrawn and a document goes into a review queue, so it runs on a disposable account against disposable local storage — a BACKEND swap, with the allow-list, size cap, server-generated key and signed-URL expiry all unchanged",
  },
  { page: "/admin/kyc", control: "KYC decision — approved", coverage: "browser" },
  { page: "/withdraw", control: "Daily cap and KYC restriction", coverage: "browser" },
  { page: "/withdraw", control: "Daily cap and KYC restriction — tier 0", coverage: "browser" },
  {
    page: "/withdraw",
    control: "Provider failure and pending states",
    coverage: "blocked",
    reason: "EXTERNAL_PROVIDER_KEY_REQUIRED",
    why: "Paystack. The failure UI is driven by a provider response nobody can produce without credentials, and inventing one would be a fixture pretending to be a bank",
  },

  // ------------------------------------------------------------------ cash-out
  { page: "/bets", control: "Cash out", coverage: "browser" },
  { page: "/bets", control: "Cash out — accept full", coverage: "browser" },
  { page: "/bets", control: "Cash out — ticket updated", coverage: "browser" },
  { page: "/bets", control: "My bets list", coverage: "browser" },
  { page: "/bets", control: "Cash out — partial option offered", coverage: "browser" },
  { page: "/bets", control: "Cash out — partial taken", coverage: "browser" },
  { page: "/bets", control: "Cash out — stale offer refusal", coverage: "browser" },

  // -------------------------------------------------------------------- pluto
  { page: "/pluto", control: "Ask Pluto — Send", coverage: "browser" },
  {
    page: "/pluto",
    control: "Mode disclosure",
    coverage: "blocked",
    reason: "EXTERNAL_PROVIDER_KEY_REQUIRED",
    why: "no language model is connected, and the page says so rather than letting a keyword router be mistaken for one",
  },

  // ------------------------------------------- honest unavailable products
  { page: "/casino", control: "Unavailable state", coverage: "blocked", reason: "COMMERCIAL_CONTRACT_REQUIRED", why: "no aggregator agreement, so there are no games to open" },
  { page: "/live-casino", control: "Unavailable state", coverage: "blocked", reason: "COMMERCIAL_CONTRACT_REQUIRED", why: "no live-casino provider agreement" },
  { page: "/virtuals", control: "Unavailable state", coverage: "blocked", reason: "COMMERCIAL_CONTRACT_REQUIRED", why: "no virtuals provider agreement" },
  { page: "/fantasy", control: "Unavailable state", coverage: "blocked", reason: "PRODUCT_DECISION_REQUIRED", why: "the scoring and entry rules do not exist, and inventing them would be a product policy nobody agreed to" },
  { page: "/lucky-numbers", control: "Unavailable state", coverage: "blocked", reason: "REGULATION_REQUIRED", why: "a certified RNG and lottery approval are required; the draw rules are also an undecided product question, and the page says both" },
  { page: "/live", control: "Live board prices", coverage: "blocked", reason: "COMMERCIAL_CONTRACT_REQUIRED", why: "no in-play feed, so prices are shown for information and are deliberately not tappable" },

  // -------------------------------------------------------------------- admin
  { page: "/admin", control: "Admin sign-in", coverage: "browser" },
  { page: "/admin", control: "Admin dashboard", coverage: "browser" },
  { page: "/admin/users", control: "User search", coverage: "browser" },
  { page: "/admin/users", control: "Newly registered user visible", coverage: "browser" },
  { page: "/admin/bets", control: "Newly placed bet visible", coverage: "browser" },
  { page: "/admin/ledger", control: "Ledger view", coverage: "browser" },
  { page: "/admin/reconciliation", control: "Reconciliation view", coverage: "browser" },
  { page: "/admin/audit", control: "Audit log", coverage: "browser" },
  { page: "/admin/kyc", control: "KYC review queue", coverage: "browser" },
  { page: "/admin/withdrawals", control: "Withdrawal review queue", coverage: "browser" },
  { page: "/admin/roles", control: "RBAC — support agent refused", coverage: "browser" },
  { page: "/admin", control: "Unauthenticated admin access refused", coverage: "browser" },
  { page: "/admin", control: "Step-up authentication", coverage: "browser" },
  { page: "/admin/withdrawals", control: "Sensitive admin action completed", coverage: "browser" },
  { page: "/admin", control: "Admin screens render", coverage: "browser" },
  { page: "/admin", control: "Cross-user access refusal", coverage: "browser" },
  { page: "/admin/roles", control: "Support agent blocked from super-admin action", coverage: "browser" },

  // ------------------------------------------------- journey-level assertions
  { page: "/wallet", control: "Stake debited exactly", coverage: "browser" },
  { page: "any", control: "QA funding unreachable by a customer", coverage: "browser" },
  { page: "/register", control: "Registration OTP guard", coverage: "browser" },

  /*
   * ------------------------------------------- INTERNAL_SECURITY_VERIFICATION
   *
   * Automated probes through the real HTTP surface, on the disposable local
   * stack. NOT a penetration test: nobody creative tried to break this, a list
   * of known shapes was fired at it and the answers recorded. An independent
   * test stays outstanding external work.
   */
  { page: "any", control: "Authentication bypass refused", coverage: "browser" },
  { page: "any", control: "Error-message identifier leakage", coverage: "browser" },
  { page: "any", control: "Cross-user object access refused", coverage: "browser" },
  { page: "/api/webhooks/paystack", control: "Webhook signature enforced", coverage: "browser" },
  { page: "any", control: "Idempotency-key conflict refused", coverage: "browser" },
  { page: "/sports", control: "Injection payloads handled as text", coverage: "browser" },
  { page: "/", control: "No secret in client JavaScript", coverage: "browser" },
  { page: "/api/odds", control: "Rate limiting holds under a burst", coverage: "browser" },
  { page: "any", control: "No test-only route in a production build", coverage: "browser" },
  { page: "/account/date-of-birth", control: "Missing-DOB wagering bypass refused", coverage: "browser" },
  { page: "/pluto", control: "AI money action requires confirmation", coverage: "browser" },
  { page: "any", control: "Session fixation and revocation", coverage: "browser" },
  { page: "any", control: "CSRF on state-changing routes", coverage: "browser" },
  { page: "any", control: "Stored and reflected XSS", coverage: "browser" },
  { page: "/kyc", control: "File-upload type, size and filename validation", coverage: "browser" },
  { page: "any", control: "SSRF-shaped input handled as text", coverage: "browser" },
  { page: "any", control: "Mass-assignment payloads refused", coverage: "browser" },
  { page: "/api/odds", control: "Rate-limit bypass with spoofed forwarding headers", coverage: "browser" },
  { page: "/api/webhooks/paystack", control: "Webhook replay", coverage: "browser" },
  {
    page: "/pluto",
    control: "Admin AI permission boundary",
    coverage: "browser",
    why: "SCAFFOLDING, and recorded as such. There is no Admin AI product and none has been specified — what is pressed is the boundary that would matter if one existed: signed in as a SUPER_ADMIN, the assistant returns no other customer's address and claims no administrative action. The audit row carries NOT_IMPLEMENTED so nobody can read this as a feature",
  },

  // ------------------------------------------ browser-to-worker settlement
  { page: "/bets", control: "Automatic settlement — won", coverage: "browser" },
  { page: "/bets", control: "Automatic settlement — lost", coverage: "browser" },
  { page: "/bets", control: "Automatic settlement — void", coverage: "browser" },
  { page: "any", control: "Settlement replay pays nothing twice", coverage: "browser" },
  { page: "/admin/bets", control: "Admin settlement agreement", coverage: "browser" },

  {
    page: "any",
    control: "Sandbox provider cannot boot as production",
    coverage: "integration-boundary",
    reason: "NON_VISUAL_INTERNAL_INVARIANT",
    why: "the refusal happens at CONSTRUCTION, before a request exists; ephemeral-guard.acceptance.spec.ts asserts it there. A running review server has already chosen its provider, so no browser can watch the choice being refused",
  },
  {
    page: "any",
    control: "Review adapters cannot boot outside a review server",
    coverage: "integration-boundary",
    reason: "NON_VISUAL_INTERNAL_INVARIANT",
    why: "the local mailbox and local KYC storage refuse on four independent environment conditions, and each has to be falsified ON ITS OWN to be worth anything; review-adapters.acceptance.spec.ts and qa-surface.acceptance.spec.ts do exactly that, one condition at a time, which a single running server cannot",
  },
  /*
   * "Dependency vulnerability audit" USED TO BE A ROW HERE, AND SHOULD NOT
   * HAVE BEEN.
   *
   * This file declares CONTROLS — things a person can press, and which
   * therefore either have browser evidence or a reason they cannot. `npm audit`
   * is a build gate over a lockfile. It has no page, no element and nobody to
   * press it, and the only way to keep it here was to give it a reason code
   * that promises a spec file it does not have. Forcing it into one of the
   * seven would have been dressing a gate up as an interface.
   *
   * It did not stop being checked. It runs as a gate and §20 records its
   * findings and their exploitability. Removing a row is normally the edit that
   * defeats this file; removing something that was never a control is the
   * opposite, and it is written down here so nobody has to wonder which
   * happened.
   */
];

/** Controls that must appear in the generated audit. */
export function controlsRequiringBrowserCoverage() {
  return CONTROL_MANIFEST.filter((c) => c.coverage === "browser");
}
