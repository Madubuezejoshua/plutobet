import { RegisterForm } from "./register-form";

export const metadata = { title: "Create an account" };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const params = await searchParams;
  // Accepted from the link a friend shared. Validated server-side at
  // registration; an unrecognised code records no referrer rather than
  // failing the signup.
  const referralCode = params.ref?.trim().toUpperCase().slice(0, 20);

  return (
    <>
      <header className="page-head">
        <h1>Create an account</h1>
        <p className="muted">You must be 18 or over to open an account.</p>
      </header>

      <RegisterForm referralCode={referralCode} />
    </>
  );
}
