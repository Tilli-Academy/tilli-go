-- Start-time alerts.
-- Existing projects keep today's behaviour (emails on); new projects start Off.
ALTER TABLE "projects" ADD COLUMN "start_alerts_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "projects" ALTER COLUMN "start_alerts_enabled" SET DEFAULT false;

-- CreateTable
CREATE TABLE "task_alerts" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recipient" TEXT,
    "sent_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_alerts_task_id_key" ON "task_alerts"("task_id");
CREATE INDEX "task_alerts_status_idx" ON "task_alerts"("status");

ALTER TABLE "task_alerts" ADD CONSTRAINT "task_alerts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
