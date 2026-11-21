-- Timezone per project (review decision): times are shown in the project's zone with UTC alongside.
-- Additive: existing projects get US Central, the zone current cutovers run in.
ALTER TABLE "projects" ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'America/Chicago';
