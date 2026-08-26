-- Local development only. Production provisions a separate runtime login and
-- grants membership with `npm run db:grant-role` after the baseline migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END;
$$;

GRANT app_role TO bet;
