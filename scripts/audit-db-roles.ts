/**
 * Who is the database actually letting us be?
 *
 *   npm run db:audit-roles
 *
 * READ-ONLY. Every statement runs inside `BEGIN … READ ONLY`, and the
 * permission probes use `has_table_privilege` / `pg_has_role`, which ASK
 * PostgreSQL what would be allowed rather than trying it. Nothing here creates,
 * alters, truncates or drops anything, on any database, ever.
 *
 * WHY THIS EXISTS
 * ---------------
 * A readiness check reported that all three configured URLs connect as
 * `neondb_owner` — the role that owns the ledger tables. That was recorded as a
 * note. It is not a note; it is the difference between "a compromised read
 * route leaks data" and "a compromised read route can drop the ledger".
 *
 * The money paths issue `SET LOCAL ROLE app_role` inside every transaction, so
 * they are safe. The POOLED read client does no role handling whatsoever, and
 * thirty-four files import it — every board query, every admin page, every
 * public route. Those all run with owner rights.
 *
 * This prints the evidence per connection so the claim can be checked rather
 * than believed, and `production:check` refuses to pass on the result.
 *
 * No credential is ever printed. Role NAMES are configuration, not secrets, and
 * are the entire point of the report.
 */
import "dotenv/config";
import postgres from "postgres";

interface RoleFacts {
  label: string;
  configured: boolean;
  sessionUser: string;
  currentUser: string;
  currentRole: string;
  isSuperuser: boolean;
  canBypassRls: boolean;
  ownsLedgerTables: boolean;
  ownedLedgerTables: string[];
  canDropLedger: boolean;
  canTruncateLedger: boolean;
  canAlterLedger: boolean;
  canCreateInPublic: boolean;
  canGrantItselfMore: boolean;
  memberOfAppRole: boolean;
  error?: string;
}

/** Tables whose integrity the whole platform rests on. */
const LEDGER_TABLES = ["ledger_entries", "ledger_transactions", "wallets"];

async function inspect(label: string, names: string[]): Promise<RoleFacts> {
  const found = names.map((n) => process.env[n]?.trim()).find(Boolean);
  const empty: RoleFacts = {
    label,
    configured: false,
    sessionUser: "-",
    currentUser: "-",
    currentRole: "-",
    isSuperuser: false,
    canBypassRls: false,
    ownsLedgerTables: false,
    ownedLedgerTables: [],
    canDropLedger: false,
    canTruncateLedger: false,
    canAlterLedger: false,
    canCreateInPublic: false,
    canGrantItselfMore: false,
    memberOfAppRole: false,
  };
  if (!found) return empty;

  const client = postgres(found, { max: 1, prepare: false, connect_timeout: 30 });
  try {
    return await client.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY");

      const [who] = await tx<
        {
          session_user: string;
          current_user: string;
          current_role: string;
          is_super: boolean;
          bypass_rls: boolean;
          can_create: boolean;
          app_role_member: boolean;
        }[]
      >`
        SELECT session_user,
               current_user,
               current_role,
               COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_super,
               COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypass_rls,
               has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
               COALESCE(pg_has_role(current_user, 'app_role', 'MEMBER'), false) AS app_role_member
      `;

      /*
       * Ownership is what grants DDL. `has_table_privilege` deliberately does
       * NOT report DROP or ALTER — PostgreSQL has no such privilege bits,
       * because those rights come from owning the table (or being superuser).
       * So ownership IS the answer to "can this role drop the ledger".
       */
      const owned = await tx<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = ANY(${LEDGER_TABLES})
          AND pg_get_userbyid(
                (SELECT relowner FROM pg_class c
                  WHERE c.relname = pg_tables.tablename AND c.relnamespace = 'public'::regnamespace)
              ) = current_user
      `;

      const [priv] = await tx<{ can_truncate: boolean }[]>`
        SELECT bool_or(has_table_privilege(current_user, t, 'TRUNCATE')) AS can_truncate
        FROM unnest(${LEDGER_TABLES}::text[]) AS t
      `;

      const ownsAny = owned.length > 0;
      const isSuper = Boolean(who!.is_super);

      return {
        label,
        configured: true,
        sessionUser: who!.session_user,
        currentUser: who!.current_user,
        currentRole: who!.current_role,
        isSuperuser: isSuper,
        canBypassRls: Boolean(who!.bypass_rls),
        ownsLedgerTables: ownsAny,
        ownedLedgerTables: owned.map((r) => r.tablename),
        // Owner or superuser can DROP and ALTER. There is no finer privilege.
        canDropLedger: ownsAny || isSuper,
        canAlterLedger: ownsAny || isSuper,
        canTruncateLedger: Boolean(priv?.can_truncate) || ownsAny || isSuper,
        canCreateInPublic: Boolean(who!.can_create),
        // Owning a table lets you GRANT on it; a superuser can grant anything.
        canGrantItselfMore: ownsAny || isSuper,
        memberOfAppRole: Boolean(who!.app_role_member),
      };
    });
  } catch (error) {
    return {
      ...empty,
      configured: true,
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : "failed",
    };
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

function yesNo(value: boolean): string {
  return value ? "YES" : "no";
}

export async function auditRoles(): Promise<RoleFacts[]> {
  return [
    await inspect("runtime pooled (reads)", ["DATABASE_URL", "POSTGRES_URL"]),
    await inspect("money / direct", [
      "DIRECT_DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "POSTGRES_URL_NON_POOLING",
    ]),
    await inspect("migration / owner", ["MIGRATION_DATABASE_URL", "DATABASE_URL_UNPOOLED"]),
  ];
}

/** True when this connection would let a compromised session wreck the ledger. */
export function isDangerousRuntimeRole(facts: RoleFacts): boolean {
  return facts.isSuperuser || facts.ownsLedgerTables || facts.canDropLedger;
}

async function main(): Promise<number> {
  const results = await auditRoles();

  console.log("DATABASE ROLE AUDIT");
  console.log("Read-only. No credential value is printed; role NAMES are configuration.");
  console.log("");

  for (const f of results) {
    console.log(`── ${f.label}`);
    if (!f.configured) {
      console.log("   not configured");
      console.log("");
      continue;
    }
    if (f.error) {
      console.log(`   could not connect: ${f.error}`);
      console.log("");
      continue;
    }
    console.log(`   session_user        ${f.sessionUser}`);
    console.log(`   current_user        ${f.currentUser}`);
    console.log(`   current_role        ${f.currentRole}`);
    console.log(`   superuser           ${yesNo(f.isSuperuser)}`);
    console.log(`   bypasses RLS        ${yesNo(f.canBypassRls)}`);
    console.log(
      `   owns ledger tables  ${yesNo(f.ownsLedgerTables)}` +
        (f.ownedLedgerTables.length ? ` (${f.ownedLedgerTables.join(", ")})` : ""),
    );
    console.log(`   can DROP ledger     ${yesNo(f.canDropLedger)}`);
    console.log(`   can ALTER ledger    ${yesNo(f.canAlterLedger)}`);
    console.log(`   can TRUNCATE ledger ${yesNo(f.canTruncateLedger)}`);
    console.log(`   can CREATE in public ${yesNo(f.canCreateInPublic)}`);
    console.log(`   can grant itself more ${yesNo(f.canGrantItselfMore)}`);
    console.log(`   member of app_role  ${yesNo(f.memberOfAppRole)}`);
    console.log("");
  }

  const runtime = results[0]!;
  if (runtime.configured && !runtime.error && isDangerousRuntimeRole(runtime)) {
    console.error("VERDICT: the runtime connection has OWNER rights over the ledger.");
    console.error("");
    console.error("  Money transactions issue SET LOCAL ROLE app_role and are safe.");
    console.error("  The pooled READ client does not, and every public route uses it.");
    console.error("  A compromised read path therefore inherits the ability to drop,");
    console.error("  alter or truncate the ledger, and to grant itself more.");
    console.error("");
    console.error("  Fix: give DATABASE_URL its own least-privilege role.");
    console.error("  See OWNER_LAUNCH_CHECKLIST.md.");
    return 1;
  }

  console.log("VERDICT: the runtime connection has no ownership of the ledger.");
  return 0;
}

// Only run when invoked directly, so `production:check` can import the audit.
if (process.argv[1]?.includes("audit-db-roles")) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("role audit failed:", error instanceof Error ? error.message : error);
      process.exit(2);
    });
}
