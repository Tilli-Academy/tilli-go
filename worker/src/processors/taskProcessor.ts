import { Job } from 'bullmq';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { canTaskExecute } from '../services/dependencyChecker';
import { addEmailJob } from '../services/emailProducer';
import type { TaskJobPayload, TaskProcessorResult } from '../types';

/**
 * task-queue processor.
 *
 * Handles three job names:
 *   - process-task:       Pending → Triggered + trigger email
 *   - process-completion: Acknowledged → completion email (no status change here)
 *   - process-no-owner:   a due task has no owner → it stays Pending, Release Management is told
 *   - process-no-owner-reminder: still no owner 15 min later → one reminder
 *   - process-reassigned: a ready (Triggered) task got a new owner → that owner is emailed
 */
const processor = async (job: Job<TaskJobPayload>): Promise<TaskProcessorResult> => {
  if (job.name === 'process-completion') return processCompletion(job);
  if (job.name === 'process-no-owner') return processNoOwner(job);
  if (job.name === 'process-no-owner-reminder') return processNoOwnerReminder(job);
  if (job.name === 'process-reassigned') return processReassigned(job);
  return processTrigger(job);
};

/**
 * process-task: Pending → Triggered
 *
 * Flow:
 *   1. Fetch task from DB
 *   2. Idempotency: skip if not Pending
 *   3. Dependency check (worker layer — per CLAUDE.md)
 *   4. Transition status → Triggered
 *   5. Audit log
 *   6. Enqueue email job (email processor handles token signing + sending)
 */
async function processTrigger(job: Job<TaskJobPayload>): Promise<TaskProcessorResult> {
  const { taskId } = job.data;
  const log = logger.child({ jobId: job.id, taskId });

  log.info('Processing task job');

  // ── 1. Fetch task ────────────────────────────────────────────────────
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, assignedUserId: true, project: { select: { startAlertsEnabled: true } } },
  });

  if (!task) {
    log.warn('Task not found in DB — skipping');
    return { status: 'skipped', reason: 'task_not_found' };
  }

  // ── 2. Idempotency ──────────────────────────────────────────────────
  if (task.status !== 'Pending') {
    log.info({ currentStatus: task.status }, 'Task already processed — skipping');
    return { status: 'skipped', reason: 'already_processed' };
  }

  // A task with no owner never starts (the scheduler holds it too).
  if (!task.assignedUserId) {
    log.info('No owner — task held');
    return { status: 'held', reason: 'no_owner' };
  }

  // ── 3. Dependency check (worker layer) ───────────────────────────────
  const depCheck = await canTaskExecute(taskId);
  if (!depCheck.executable) {
    const blockers = depCheck.blockingTasks.map((t) => t.taskName).join(', ');
    log.warn({ blockers }, 'Dependencies not met — will retry');
    throw new Error(`Dependencies not met: ${blockers}`);
  }

  // ── 4. Transition Pending → Triggered + audit log (atomic) ──────────
  // Only if it is still Pending with the same owner: a change made after step 1
  // (e.g. marked N/A, or reassigned) is never overwritten.
  const triggered = await prisma.$transaction(async (tx) => {
    const moved = await tx.task.updateMany({
      where: { id: taskId, status: 'Pending', assignedUserId: task.assignedUserId },
      data: { status: 'Triggered' },
    });
    if (moved.count === 0) return false;
    await tx.auditLog.create({
      data: { taskId, action: 'SYSTEM_UPDATED', field: 'status', oldValue: 'Pending', newValue: 'Triggered' },
    });
    return true;
  });
  if (!triggered) {
    log.info('Task changed while being processed (status or owner) — not triggered');
    return { status: 'skipped', reason: 'changed_meanwhile' };
  }

  log.info('Task status → Triggered');

  // ── 5b. Start-time alerts are switched on per project ───────────────
  if (!task.project.startAlertsEnabled) {
    log.info('Start-time alerts are off for this project — no email');
    return { status: 'triggered', taskId };
  }

  // ── 6. Enqueue email ────────────────────────────────────────────────
  // Only taskId is passed — the email processor fetches the task,
  // signs the ack token, and sends via nodemailer.
  await addEmailJob({ taskId, type: 'triggered', ownerId: task.assignedUserId });

  return { status: 'triggered', taskId };
}

/**
 * process-completion: Send completion email for Acknowledged tasks.
 *
 * No status transition here — the user clicks the link to complete.
 */
async function processCompletion(job: Job<TaskJobPayload>): Promise<TaskProcessorResult> {
  const { taskId } = job.data;
  const log = logger.child({ jobId: job.id, taskId });

  log.info('Processing completion job');

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, project: { select: { startAlertsEnabled: true } } },
  });

  if (!task) {
    log.warn('Task not found in DB — skipping');
    return { status: 'skipped', reason: 'task_not_found' };
  }

  // Idempotency: only send completion email for Acknowledged tasks
  if (task.status !== 'Acknowledged') {
    log.info({ currentStatus: task.status }, 'Task not Acknowledged — skipping completion');
    return { status: 'skipped', reason: 'not_acknowledged' };
  }

  // Same switch as start-time alerts: no emails for projects that have them off.
  if (!task.project.startAlertsEnabled) {
    log.info('Alerts are off for this project — no completion email');
    return { status: 'skipped', reason: 'alerts_off' };
  }

  await addEmailJob({ taskId, type: 'completion' });

  log.info('Completion email job enqueued');
  return { status: 'completion_enqueued', taskId };
}

/** process-no-owner: the task stays Pending; Release Management is emailed once (if alerts are on). */
async function processNoOwner(job: Job<TaskJobPayload>): Promise<TaskProcessorResult> {
  const { taskId } = job.data;
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, assignedUserId: true, project: { select: { startAlertsEnabled: true } } },
  });
  if (!task || task.status !== 'Pending' || task.assignedUserId) return { status: 'skipped', reason: 'not_held' };
  if (!task.project.startAlertsEnabled) return { status: 'held', reason: 'alerts_off' };
  await addEmailJob({ taskId, type: 'no_owner' });
  return { status: 'held', taskId };
}

/** process-no-owner-reminder: one reminder while the task is still held with no owner. */
async function processNoOwnerReminder(job: Job<TaskJobPayload>): Promise<TaskProcessorResult> {
  const { taskId } = job.data;
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, assignedUserId: true, project: { select: { startAlertsEnabled: true } } },
  });
  // Stop as soon as an owner is assigned
  if (!task || task.status !== 'Pending' || task.assignedUserId) return { status: 'skipped', reason: 'owner_assigned' };
  if (!task.project.startAlertsEnabled) return { status: 'held', reason: 'alerts_off' };
  await addEmailJob({ taskId, type: 'no_owner_reminder' });
  return { status: 'held', taskId };
}

/**
 * process-reassigned: the task was already ready to start (Triggered) and got a new
 * owner. Email them, if alerts are on. The email processor keeps the rule of one
 * alert per task per owner.
 */
async function processReassigned(job: Job<TaskJobPayload>): Promise<TaskProcessorResult> {
  const { taskId, assignedUserId } = job.data;
  const log = logger.child({ jobId: job.id, taskId });
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, assignedUserId: true, project: { select: { startAlertsEnabled: true } } },
  });
  if (!task || task.status !== 'Triggered') return { status: 'skipped', reason: 'not_ready' };
  if (!task.assignedUserId || task.assignedUserId !== assignedUserId) return { status: 'skipped', reason: 'owner_changed_again' };
  if (!task.project.startAlertsEnabled) return { status: 'skipped', reason: 'alerts_off' };
  await addEmailJob({ taskId, type: 'triggered', ownerId: task.assignedUserId });
  log.info({ ownerId: task.assignedUserId }, 'New owner of a ready task — start alert queued');
  return { status: 'triggered', taskId };
}

export = processor;
