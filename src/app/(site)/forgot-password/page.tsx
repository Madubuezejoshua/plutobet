import { ResetForm } from "./reset-form";

export const metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <header className="page-head">
        <h1>Reset your password</h1>
        <p className="muted">We will email you a code.</p>
      </header>

      <ResetForm />
    </>
  );
}
