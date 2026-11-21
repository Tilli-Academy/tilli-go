/**
 * Payload enqueued to task-queue by the scheduler.
 * Contains denormalized task fields so the worker can log
 * context without an immediate DB fetch.
 */
export interface TaskJobPayload {
  taskId: string;
  taskName: string;
  system: string;
  assignedTeam: string | null;
  assignedUserId: string | null;
}

/** Payload enqueued to email-queue by the task processor */
export interface EmailJobPayload {
  taskId: string;
  type?: 'triggered' | 'completion' | 'no_owner' | 'no_owner_reminder';
  /** Start alert: the owner it is for (one alert per task per owner). */
  ownerId?: string | null;
}

// ── Processor results ────────────────────────────────────────────────────────

export interface TaskProcessorResult {
  status: 'skipped' | 'triggered' | 'completion_enqueued' | 'held';
  reason?: string;
  taskId?: string;
}

export interface EmailProcessorResult {
  status: 'skipped' | 'sent';
  reason?: string;
  messageId?: string;
}
