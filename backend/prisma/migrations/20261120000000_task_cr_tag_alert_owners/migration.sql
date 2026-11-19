-- Review follow-up: task-to-CR tag, one start alert per task per owner, no-owner reminder.
-- Additive only.

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "change_request_id" TEXT;

-- AlterTable
ALTER TABLE "task_alerts" ADD COLUMN     "notified_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reminder_sent_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "tasks_change_request_id_idx" ON "tasks"("change_request_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Owners already emailed: existing sent/acknowledged alerts count for the person they went to.
UPDATE "task_alerts" a SET "notified_user_ids" = ARRAY[u."id"]
FROM "users" u
WHERE a."status" IN ('SENT', 'ACKNOWLEDGED') AND lower(u."email") = lower(a."recipient");
