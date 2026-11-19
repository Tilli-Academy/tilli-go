-- Completion email is sent once per task. Additive: a nullable column, no data change.
ALTER TABLE "tasks" ADD COLUMN "completion_email_sent_at" TIMESTAMP(3);
