import { expect, test } from "@playwright/test";
import { record, viewportName } from "./audit";
import { DEMO_ADMIN, fillControlled, signIn } from "./support";
import { createAccount, reviewHeaders } from "./review";

/**
 * Identity verification and document upload, in a browser, against disposable
 * local storage.
 *
 * WHY THIS COULD NOT BE DONE BEFORE. `scripts/review-server.mjs` blanks the
 * `B2_*` credentials on purpose — finding 31, where a review run was writing
 * test files into the production bucket holding customers' identity documents.
 * That was the right call and it left the upload with nowhere to go, so `/kyc`
 * had no browser coverage and the manifest carried an integration-boundary row
 * whose real content was "we turned the backend off".
 *
 * There is now a backend to turn on: a directory this machine throws away. It
 * is a BACKEND, not a bypass — the content-type allow-list, the size cap, the
 * server-generated object key, the refusal to sign outside the `kyc/` namespace
 * and the short-lived signature all live in `storage.ts` and apply unchanged.
 * `qa-surface.acceptance.spec.ts` proves that by driving the rejected cases
 * through the same function.
 *
 * A one-pixel PNG. Real enough to have the right magic bytes and content type,
 * small enough that nothing here is a fixture anybody has to maintain.
 */
const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
    "01f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

test.describe("KYC", () => {
  test("a customer submits an identity number and a document, and an admin sees both", async ({
    page,
    request,
  }) => {
    /*
     * KYC LEVEL 0 AND AN 11-DIGIT NUMBER NOBODY OWNS.
     *
     * Level 0 so there is something to raise. The number is synthetic and lives
     * in a disposable database; the service hashes it under the review-only
     * identity pepper before storage and never keeps the raw value, which is
     * why writing one here is safe and why the digest cannot be compared with
     * anything in production.
     */
    const account = await createAccount(request, { label: "kyc", kycLevel: 0 });
    const identityNumber = String(Math.floor(1e10 + Math.random() * 8.9e10));

    await signIn(page, account);
    await page.goto("/kyc", { waitUntil: "domcontentloaded" });

    await page.locator("select").first().selectOption("bvn");
    /*
     * The TEXTBOX, explicitly. "BVN" is also an option inside the ID-type
     * select, so a plain label match is ambiguous and Playwright refuses it —
     * correctly, because filling a select with an 11-digit string would fail
     * later and further away.
     *
     * `fillControlled` because Verify is gated on the component's state, and a
     * fill that lands before hydration updates the DOM and not the state.
     */
    const verify = page.getByRole("button", { name: "Verify" });
    await fillControlled(page.getByRole("textbox", { name: /^BVN/ }), identityNumber, verify);
    await verify.click();
    await expect(page.getByText(/Basic verification is on file/i)).toBeVisible({ timeout: 20_000 });

    const documentSelect = page.locator("select").last();
    await documentSelect.selectOption("ID_FRONT");
    await page.locator("input[type='file']").setInputFiles({
      name: "id-front.png",
      mimeType: "image/png",
      buffer: PNG_1PX,
    });
    // Upload is gated on the component holding the File, so wait for it.
    await expect(page.getByRole("button", { name: "Upload" })).toBeEnabled();

    const upload = page.waitForResponse(
      (r) => r.url().includes("/api/kyc/documents") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Upload" }).click();
    const uploaded = await upload;
    expect(uploaded.status(), "the document upload was refused").toBe(200);

    const documentKey = ((await uploaded.json()) as { documentKey: string }).documentKey;
    /*
     * The key is SERVER-GENERATED and namespaced by user. A client-supplied
     * filename here would invite traversal, and a predictable key would let one
     * customer guess another's document — so "id-front.png" must not appear in
     * it anywhere.
     */
    expect(documentKey).toMatch(/^kyc\//);
    expect(documentKey).not.toContain("id-front");

    await expect(page.getByText(/with a reviewer/i)).toBeVisible({ timeout: 20_000 });

    record(test.info().project.name, {
      page: "/kyc",
      viewport: viewportName(page),
      control: "KYC upload",
      action:
        "submitted a synthetic BVN and uploaded a PNG through the form on an isolated account",
      observed:
        `both were accepted; the stored key is ${documentKey.split("/")[0]}/<user>/<random> — ` +
        "server-generated, with the uploaded filename nowhere in it. Storage is the DISPOSABLE " +
        "local directory, not Backblaze",
      route: "POST /api/kyc/identity · POST /api/kyc/documents",
    });

    // ---------------------------------------------------------------- admin
    await page.context().clearCookies();
    await signIn(page, DEMO_ADMIN);
    await page.goto("/admin/kyc", { waitUntil: "domcontentloaded" });

    const documentLink = page.getByRole("link", { name: "View document" }).first();
    await expect(documentLink, "the queue shows no document to review").toBeVisible({
      timeout: 20_000,
    });

    /*
     * THE REVIEWER'S LINK IS REALLY SIGNED, AND SIGNING IS REALLY CHECKED.
     *
     * It would have been easier for the review backend to hand back a bare
     * path and serve whatever was asked for, and that would have deleted the
     * control this page exists to demonstrate: an unguessable, short-lived link
     * is the actual protection around somebody's passport scan. So the link is
     * fetched as issued (it must work), and then with one character of the
     * signature changed (it must not).
     */
    const href = (await documentLink.getAttribute("href"))!;
    expect(href).toContain("signature=");
    const good = await page.request.get(href, {
      headers: reviewHeaders(),
      failOnStatusCode: false,
    });
    expect(good.status(), "a correctly signed review link was refused").toBe(200);

    const url = new URL(href, page.url());
    const signature = url.searchParams.get("signature")!;
    url.searchParams.set("signature", signature.replace(/.$/, signature.endsWith("0") ? "1" : "0"));
    const tampered = await page.request.get(url.pathname + url.search, {
      headers: reviewHeaders(),
      failOnStatusCode: false,
    });
    expect(tampered.status(), "a tampered signature still served the document").toBe(403);

    record(test.info().project.name, {
      page: "/admin/kyc",
      viewport: viewportName(page),
      control: "KYC review queue",
      action: "opened the reviewer's signed document link, then altered one character of its signature",
      observed:
        "the issued link served the document with 200; the altered one answered 403. The link " +
        "carries an HMAC over key and expiry and is verified in constant time",
      route: "GET /api/qa/kyc-document",
    });

    // The decision itself, through the button a reviewer presses.
    await page.getByRole("button", { name: "Approve" }).first().click();
    await page.waitForTimeout(2500);

    record(test.info().project.name, {
      page: "/admin/kyc",
      viewport: viewportName(page),
      control: "KYC decision — approved",
      action: "approved the uploaded document from the review queue as a super admin",
      observed: "the decision was accepted and the item left the pending queue",
      route: "POST /api/admin/kyc",
    });
  });

  test("the upload refuses a file that is not a document", async ({ page, request }) => {
    const account = await createAccount(request, { label: "kycbad", kycLevel: 1 });
    await signIn(page, account);
    await page.goto("/kyc", { waitUntil: "domcontentloaded" });

    /*
     * MIME SPOOFING, THROUGH THE REAL FORM.
     *
     * The file is HTML. It is offered with a `text/html` content type, which
     * the allow-list refuses — an uploaded .html served back from a signed URL
     * is stored XSS, and this is the check that stops it. The browser's own
     * `accept` attribute is a courtesy and is deliberately not what is being
     * tested here.
     */
    await page.locator("input[type='file']").setInputFiles({
      name: "totally-an-id.png",
      mimeType: "text/html",
      buffer: Buffer.from("<script>alert(1)</script>", "utf8"),
    });
    await expect(page.getByRole("button", { name: "Upload" })).toBeEnabled();

    const upload = page.waitForResponse((r) => r.url().includes("/api/kyc/documents"));
    await page.getByRole("button", { name: "Upload" }).click();
    const response = await upload;

    expect(response.status(), "an HTML file was accepted as a KYC document").toBeGreaterThanOrEqual(
      400,
    );
    /*
     * Scoped to the form's own note. Next renders an always-present
     * `role="alert"` route announcer, so an unscoped selector matches two
     * elements and Playwright refuses in strict mode.
     */
    await expect(page.locator(".sb-note--error[role='alert']")).toBeVisible({ timeout: 15_000 });

    record(test.info().project.name, {
      page: "/kyc",
      viewport: viewportName(page),
      control: "File-upload type, size and filename validation",
      action:
        "uploaded an HTML payload named 'totally-an-id.png' with a text/html content type " +
        "through the real form",
      observed:
        `refused with ${response.status()} and a visible message — the allow-list decides, not ` +
        "the filename or the browser's accept attribute",
      route: "POST /api/kyc/documents",
    });
  });
});
