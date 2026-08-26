import { RegisterForm } from "./register-form";

export const metadata = { title: "Create an account" };

export default function RegisterPage() {
  return (
    <main className="shell">
      <nav className="nav" aria-label="Primary navigation">
        <div className="brand">Bet Platform</div>
        <div className="nav-links">
          <a href="/sports">Sports</a>
          <a href="/api/auth/signin">Sign in</a>
        </div>
      </nav>

      <header className="page-head">
        <h1>Create an account</h1>
        <p className="muted">You must be 18 or over to open an account.</p>
      </header>

      <RegisterForm />
    </main>
  );
}
