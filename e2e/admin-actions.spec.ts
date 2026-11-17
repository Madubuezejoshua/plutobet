import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { DEMO_ADMIN, signIn } from "./support";
import { createAccount, invariants } from "./review";
import { resolveAccount } from "./banking";

/**
 * A sensitive administrative action, performed successfully — and refused
 * without its step-up.
 *
 * WHAT WAS MISSING. The admin suite proved a support agent is refused, that
 * every screen renders, and that an anonymous caller gets nothing. It never
 * once completed a privileged action, so "step-up authentication" was declared
 * an integration boundary on the grounds that a browser "can only show the
 * prompt". A browser can do considerably more than show the prompt: it can be
 * refused without one, then satisfy it, then succeed — which is the whole
 * control, in the order an operator meets it.
 *
 * APPROVING A PAYOUT is the right action to choose. It is the one where an
 * unlocked laptop must not be enough, it demands a written reason that lands in
 * the audit log, and it moves a customer's money. It also does NOT send the
 * money — approval moves the row to APPROVED and a worker picks it up — so
 * nothing here reaches a payment provider.
 */

test.describe("sensitive admin actions", () => {
  test("a payout is refused without step-up, then approved with it, and audited", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const project = test.info().project.name;
    const viewport = viewportName(page);

    // A verified, funded customer with a withdrawal waiting for a decision.
    const customer = await createAccount(request, {
      label: "payout",
      kycLevel: 2,
      fundMinor: "20000000", // ₦200,000
    });

    await signIn(page, customer);
    // The provider's own answer for this account. A withdrawal will accept no
    // other name, so the test asks the same way the form does.
    const payTo = await resolveAccount(page.request);
    const requested = await page.request.post("/api/withdrawals", {
      data: {
        amountMinor: "3000000", // ₦30,000, inside the tier-2 daily cap
        bankCode: payTo.bankCode,
        accountNumber: payTo.accountNumber,
        confirmedAccountName: payTo.accountName,
        idempotencyKey: `payout-${Date.now()}`,
      },
      failOnStatusCode: false,
    });
    expect(requested.status(), "the withdrawal request was not created").toBe(201);
    const withdrawalId = ((await requested.json()) as { withdrawalId: string }).withdrawalId;

    // --------------------------------------------------------------- admin
    await page.context().clearCookies();
    await signIn(page, DEMO_ADMIN);

    /*
     * THE BYPASS ATTEMPT COMES FIRST.
     *
     * A super admin with a live session, calling the route directly, with a
     * perfectly valid body — and no step-up. This is the shape of the attack
     * that matters: not an outsider, but an authenticated administrator whose
     * laptop somebody else is sitting at. The proof of re-authentication is
     * held SERVER-SIDE in Redis and is never accepted from the request, so
     * there is nothing to forge in this call.
     */
    const withoutStepUp = await page.request.post("/api/admin/withdrawals", {
      data: {
        withdrawalId,
        decision: "APPROVE",
        reason: "attempting to approve without confirming a password",
      },
      failOnStatusCode: false,
    });
    expect(
      withoutStepUp.status(),
      "a payout was approved by a signed-in admin who had not re-authenticated",
    ).toBe(401);
    expect(await withoutStepUp.text()).toContain("REAUTH_REQUIRED");

    record(project, {
      page: "/admin",
      viewport,
      control: "Step-up authentication",
      action:
        "posted a valid approval to /api/admin/withdrawals as a SUPER_ADMIN with a live session " +
        "and no step-up",
      observed:
        "refused with 401 REAUTH_REQUIRED. The proof is held server-side and is never read from " +
        "the request, so nothing in the body could satisfy it",
      route: "POST /api/admin/withdrawals",
    });

    // ---------------------------------------- and now the same action, properly
    await page.goto("/admin/withdrawals", { waitUntil: "domcontentloaded" });
    const row = page.locator("tr").filter({ hasText: customer.email }).first();
    await expect(row, "the withdrawal queue does not show the pending request").toBeVisible({
      timeout: 20_000,
    });

    await row.getByRole("button", { name: "Approve" }).click();

    const reason = `review pass: approving ${customer.email}'s ₦30,000 payout`;
    await page.getByLabel(/^Reason/).fill(reason);
    await page.getByLabel(/Confirm your password/).fill(DEMO_ADMIN.password);

    const approving = page.waitForResponse(
      (r) => r.url().includes("/api/admin/withdrawals") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Approve payout" }).click();
    const approved = await approving;
    expect(
      approved.status(),
      `the approval was refused after a correct password: ${await approved.text()}`,
    ).toBe(200);

    await expect(page.getByText(/Approved/i).first()).toBeVisible({ timeout: 20_000 });

    record(project, {
      page: "/admin/withdrawals",
      viewport,
      control: "Sensitive admin action completed",
      action:
        "approved the same payout from the queue, supplying the mandatory reason and confirming " +
        "the administrator's password",
      observed:
        "accepted with 200 after the step-up that the identical request was refused for moments " +
        "earlier. Approval queues the transfer; it does not send it, so no provider was reached",
      route: "POST /api/admin/reauth · POST /api/admin/withdrawals",
    });

    // --------------------------------------------------- the audit trail exists
    await page.goto("/admin/audit", { waitUntil: "domcontentloaded" });
    const auditText = await page.locator("body").innerText();
    expect(
      auditText,
      "the audit log does not record the payout approval, or does not record its reason",
    ).toContain("review pass: approving");

    record(project, {
      page: "/admin/audit",
      viewport,
      control: "Audit log",
      action: "opened the audit log immediately after approving a payout",
      observed:
        "the approval is recorded with the written reason the operator supplied — money that " +
        "moved with nobody accountable is the first thing an auditor asks about",
      route: "GET /admin/audit",
    });

    const report = await invariants(request);
    expect(
      report.violations,
      `money invariants broke around the approval: ${report.violations.join(", ")}`,
    ).toEqual([]);
  });
});
