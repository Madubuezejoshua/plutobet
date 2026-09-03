@AGENTS.md

# Reporting

After every implementation, test, repair, deployment or audit task, update
`/general.md` with evidence-backed current status before reporting completion.

`general.md` is the single source of truth for the state of this project. If a
change makes anything in it untrue — a gate result, a status label, a blocker, a
control in the interaction inventory — the change is not finished until that
section is corrected.

Rules that file follows, and so does anything written into it:

- A claim carries its evidence, or it is not made. "Tested" means a named test;
  "works" means an observed run.
- Passing tests are never presented as proof that an external service works.
- Nothing is described as automatic if it was invoked by hand.
- No credential, connection string, one-time code or personal detail is ever
  written into it. Environment variables are named and reported only as set,
  missing or blocked.
- A single completion percentage is not used.
