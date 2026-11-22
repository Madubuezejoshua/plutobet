-- Activate all 13 sports in the canonical sportsbook catalog and seed the two
-- missing keys (handball, american-football) so taxonomy classification and
-- browse queries recognise every live sport.

INSERT INTO "sports" ("key", "name", "active", "display_order") VALUES
  ('handball',          'Handball',          true, 85),
  ('american-football', 'American Football', true, 105)
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "active" = true;
--> statement-breakpoint

UPDATE "sports"
SET "active" = true,
    "display_order" = CASE "key"
      WHEN 'football'          THEN 10
      WHEN 'basketball'        THEN 20
      WHEN 'tennis'            THEN 30
      WHEN 'table-tennis'      THEN 40
      WHEN 'esports'           THEN 50
      WHEN 'ice-hockey'        THEN 60
      WHEN 'volleyball'        THEN 70
      WHEN 'handball'          THEN 80
      WHEN 'mma'               THEN 90
      WHEN 'boxing'            THEN 100
      WHEN 'american-football' THEN 110
      WHEN 'baseball'          THEN 120
      WHEN 'cricket'           THEN 130
      ELSE "display_order"
    END
WHERE "key" IN (
  'football',
  'basketball',
  'tennis',
  'table-tennis',
  'esports',
  'ice-hockey',
  'volleyball',
  'handball',
  'mma',
  'boxing',
  'american-football',
  'baseball',
  'cricket'
);
--> statement-breakpoint

UPDATE "events" e
SET "sport_id" = s."id"
FROM "sports" s
WHERE e."sport_id" IS NULL
  AND lower(e."sport") = s."key";
