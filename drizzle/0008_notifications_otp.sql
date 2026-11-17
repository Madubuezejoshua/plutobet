-- Notifications: one-time codes and a delivery log.
--
-- Run only through the unpooled owner/migration connection.

CREATE TYPE "otp_channel" AS ENUM ('SMS', 'EMAIL');
--> statement-breakpoint
CREATE TYPE "otp_purpose" AS ENUM (
  'PHONE_VERIFY',
  'EMAIL_VERIFY',
  'LOGIN',
  'WITHDRAWAL_CONFIRM',
  'PASSWORD_RESET'
);
--> statement-breakpoint
CREATE TYPE "delivery_status" AS ENUM ('SENT', 'FAILED');
--> statement-breakpoint

CREATE TABLE "otp_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- E.164 phone or lower-cased email. NOT a user id: a code is issued during
  -- registration before any account exists, and the destination is the thing
  -- actually being proven.
  "destination" text NOT NULL,
  "channel" "otp_channel" NOT NULL,
  "purpose" "otp_purpose" NOT NULL,

  -- Set once the code belongs to a known account. Nullable for signup.
  "user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- The code is NEVER stored in the clear. A leaked table must not hand an
  -- attacker a working code — and support staff reading a code out of the
  -- database is itself the social-engineering attack OTP exists to stop.
  "code_hash" text NOT NULL,

  -- A six-digit code is 10^6 guesses; only the attempt cap makes it strong.
  -- Without it an attacker walks the whole space in minutes.
  "attempts" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,

  "expires_at" timestamp(6) with time zone NOT NULL,
  "consumed_at" timestamp(6) with time zone,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "otp_codes_hash_is_digest" CHECK ("code_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "otp_codes_attempts_bounded" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts"),
  CONSTRAINT "otp_codes_max_attempts_positive" CHECK ("max_attempts" > 0)
);
--> statement-breakpoint
CREATE INDEX "otp_codes_lookup_idx"
  ON "otp_codes" ("destination", "purpose", "created_at" DESC);
--> statement-breakpoint

-- Delivery log: what we sent, where, and whether it left the building.
--
-- Kept separate from otp_codes because it outlives them (codes are pruned,
-- the record that an SMS was billed is not) and because it covers every
-- message, not just codes. It never stores the message body: an OTP body
-- contains the code, which would defeat hashing it next door.
CREATE TABLE "notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel" "otp_channel" NOT NULL,
  "destination" text NOT NULL,
  "template" text NOT NULL,
  "status" "delivery_status" NOT NULL,
  "provider" text NOT NULL,
  "provider_ref" text,
  "error" text,
  "user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notification_deliveries_destination_idx"
  ON "notification_deliveries" ("destination", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "notification_deliveries_user_idx"
  ON "notification_deliveries" ("user_id", "created_at" DESC);
--> statement-breakpoint

GRANT USAGE ON TYPE "otp_channel", "otp_purpose", "delivery_status" TO app_role;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "otp_codes" TO app_role;
--> statement-breakpoint

-- The delivery log is evidence of a billed message. Append-only.
GRANT SELECT, INSERT ON TABLE "notification_deliveries" TO app_role;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "notification_deliveries" FROM app_role;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON TABLE "otp_codes" FROM app_role;
