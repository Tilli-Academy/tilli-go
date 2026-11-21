-- Recoverable email delivery: a claim records who is sending and since when, so a claim
-- left behind by a crashed worker can be taken over after a lease. Additive only.

ALTER TABLE "tasks" ADD COLUMN "completion_email_status" TEXT;
ALTER TABLE "tasks" ADD COLUMN "completion_email_claimed_at" TIMESTAMP(3);
-- Under the previous design completion_email_sent_at was set when the send started.
UPDATE "tasks" SET "completion_email_status" = 'SENT' WHERE "completion_email_sent_at" IS NOT NULL;

ALTER TABLE "task_alerts" ADD COLUMN "claim_user_id" TEXT;
ALTER TABLE "task_alerts" ADD COLUMN "claimed_at" TIMESTAMP(3);
-- Under the previous design a SENDING row had its owner appended to notified_user_ids
-- before the send. Turn that into a claim (owner removed from the "emailed" list), so a
-- send that never finished is retried instead of being lost.
UPDATE "task_alerts"
   SET "claim_user_id" = "notified_user_ids"[array_length("notified_user_ids", 1)],
       "claimed_at" = "updated_at",
       "notified_user_ids" = "notified_user_ids"[1:array_length("notified_user_ids", 1) - 1]
 WHERE "status" = 'SENDING' AND array_length("notified_user_ids", 1) > 0;

CREATE INDEX "task_alerts_claimed_at_idx" ON "task_alerts"("claimed_at");
