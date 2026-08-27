-- KYC document review workflow.
--
-- attachDocument() inserts a level-0 record holding only a document key.
-- Before this migration there was no column distinguishing "uploaded,
-- nobody has looked yet" from "an admin already acted on it" — verified_at
-- was unusable for that because self-attested BVN/NIN records set it too.
-- status makes the queue explicit instead of inferring it.

CREATE TYPE "kyc_review_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
--> statement-breakpoint

ALTER TABLE "kyc_records" ADD COLUMN "status" "kyc_review_status" NOT NULL DEFAULT 'PENDING';
--> statement-breakpoint
ALTER TABLE "kyc_records" ADD COLUMN "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE RESTRICT;
--> statement-breakpoint
ALTER TABLE "kyc_records" ADD COLUMN "reviewer_note" text;
--> statement-breakpoint

-- Self-attested BVN/NIN records are approved the instant verifyIdentity()
-- inserts them; only document-only rows wait on a human reviewer.
UPDATE "kyc_records" SET "status" = 'APPROVED' WHERE "verified_at" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX "kyc_records_pending_idx" ON "kyc_records" ("created_at")
  WHERE "status" = 'PENDING' AND "document_key" IS NOT NULL;
--> statement-breakpoint

-- A decision, once recorded, is evidence — an admin cannot un-review a
-- record by editing it back to PENDING or swapping who reviewed it.
CREATE OR REPLACE FUNCTION kyc_records_guard_review() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PENDING' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'kyc record % review decision is final', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reviewed_by IS NOT NULL AND NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by THEN
    RAISE EXCEPTION 'kyc record % reviewer is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER kyc_records_guard_review_trigger
  BEFORE UPDATE ON "kyc_records"
  FOR EACH ROW EXECUTE FUNCTION kyc_records_guard_review();
--> statement-breakpoint

GRANT USAGE ON TYPE "kyc_review_status" TO app_role;
--> statement-breakpoint
GRANT UPDATE ON TABLE "kyc_records" TO app_role;
