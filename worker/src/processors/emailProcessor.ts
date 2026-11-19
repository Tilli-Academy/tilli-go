import { Job } from 'bullmq';
import prisma from '../config/prisma';
import logger from '../config/logger';
import config from '../config';
import { sendCompletionEmail, sendMailInternal } from '../services/emailService';
import { buildManagerNotice, buildStartAlert, type AlertTask } from '../services/alertEmail';
import type { EmailJobPayload, EmailProcessorResult } from '../types';

/**
 * email-queue processor. Three kinds of email:
 *   - triggered  → start-time alert to the task owner (one per task)
 *   - completion → "ready for completion" to the task owner
 *   - no_owner   → the task is due but has no owner; Release Management is told
 *   - no_owner_reminder → still no owner 15 min later; Release Management is reminded once
 *
 * Retries are handled by BullMQ (5 attempts, exponential backoff); only a failed
 * send is retried. The jobId "email-{taskId}-{type}" prevents duplicate enqueues
 * and the task_alerts row prevents duplicate sends.
 */
const processor = async (job: Job<EmailJobPayload>): Promise<EmailProcessorResult> => {
  const { taskId, type } = job.data;
  const log = logger.child({ jobId: job.id, taskId, emailType: type });

  log.info('Processing email job');

  const task = (await prisma.task.findUnique({ where: { id: taskId }, include: ALERT_TASK_INCLUDE })) as
    | (AlertTask & { status: string })
    | null;
  if (!task) {
    log.warn('Task not found — skipping email');
    return { status: 'skipped', reason: 'task_not_found' };
  }

  if (type === 'completion') return sendCompletion(task, log);
  if (type === 'no_owner') return noOwnerNotice(task, log);
  if (type === 'no_owner_reminder') return noOwnerReminder(task, log);

  // ── Default: start-time alert ───────────────────────────────────────
  if (task.status !== 'Triggered') {
    log.info({ currentStatus: task.status }, 'Task no longer in Triggered state — skipping email');
    return { status: 'skipped', reason: 'status_moved_on' };
  }
  return sendStartAlert(job, task, log);
};

const ALERT_TASK_INCLUDE = {
  assignedUser: { select: { id: true, email: true, name: true } },
  project: { select: { code: true, name: true, timeZone: true } },
  dependsOn: { select: { dependsOn: { select: { sequenceNumber: true, taskName: true, actualEndTime: true } } } },
} as const;

async function recordAlert(taskId: string, data: Record<string, unknown>): Promise<void> {
  await prisma.taskAlert.upsert({
    where: { taskId },
    create: { taskId, status: String(data.status), ...data },
    update: data,
  });
}

async function audit(taskId: string, action: string, newValue: string): Promise<void> {
  try {
    await prisma.auditLog.create({ data: { taskId, action, field: null, oldValue: null, newValue } });
  } catch (err: unknown) {
    logger.error({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Audit log write failed');
  }
}

function domainAllowed(email: string): boolean {
  const domain = email.split('@').pop()?.toLowerCase() ?? '';
  return config.alerts.allowedDomains.includes(domain);
}

/** Best effort: tell the release manager. Never throws. */
async function tellManager(task: AlertTask, reason: 'no_owner' | 'no_owner_reminder' | 'blocked_domain' | 'failed', detail?: string) {
  try {
    const { subject, html } = buildManagerNotice(task, reason, detail);
    await sendMailInternal(config.alerts.releaseManager, subject, html, 'RELEASE MANAGER NOTICE');
  } catch (err: unknown) {
    logger.error({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, 'Release manager notice failed');
  }
}

async function sendCompletion(task: AlertTask & { status: string }, log: typeof logger): Promise<EmailProcessorResult> {
  // Completion emails are only sent for Acknowledged tasks
  if (task.status !== 'Acknowledged') {
    log.info({ currentStatus: task.status }, 'Task not Acknowledged — skipping completion email');
    return { status: 'skipped', reason: 'status_moved_on' };
  }
  // Never guess an address from a team name, and only email company addresses.
  const to = task.assignedUser?.email;
  if (!to || !domainAllowed(to)) {
    log.info({ to: to ?? null }, 'No company owner address — skipping completion email');
    return { status: 'skipped', reason: to ? 'blocked_domain' : 'no_owner' };
  }
  const result = await sendCompletionEmail(task, to);
  await audit(task.id, 'SYSTEM_EMAIL_SENT', `type=completion to=${to} messageId=${result.messageId}`);
  log.info({ messageId: result.messageId }, 'Completion email sent successfully');
  return { status: 'sent', messageId: result.messageId };
}

/** The scheduler holds a due task that has no owner; tell Release Management once. */
async function noOwnerNotice(task: AlertTask & { status: string }, log: typeof logger): Promise<EmailProcessorResult> {
  if (task.assignedUser || task.status !== 'Pending') {
    log.info('Task has an owner now (or moved on) — no notice needed');
    return { status: 'skipped', reason: 'owner_assigned' };
  }
  const existing = await prisma.taskAlert.findUnique({ where: { taskId: task.id } });
  if (existing?.status === 'NO_OWNER') return { status: 'skipped', reason: 'already_alerted' };
  await recordAlert(task.id, { status: 'NO_OWNER', recipient: config.alerts.releaseManager, sentAt: new Date(), reminderSentAt: null });
  await audit(task.id, 'ALERT_NO_OWNER', `due but no owner — held, release manager told (${config.alerts.releaseManager})`);
  await tellManager(task, 'no_owner');
  return { status: 'sent' };
}

/**
 * One reminder to Release Management, 15 min after the no-owner notice (the scheduler
 * decides when). Nothing is sent once someone is assigned or the task has moved on.
 */
async function noOwnerReminder(task: AlertTask & { status: string }, log: typeof logger): Promise<EmailProcessorResult> {
  if (task.assignedUser || task.status !== 'Pending') {
    log.info('Owner assigned (or task moved on) — no reminder');
    return { status: 'skipped', reason: 'owner_assigned' };
  }
  const existing = await prisma.taskAlert.findUnique({ where: { taskId: task.id } });
  if (existing?.status !== 'NO_OWNER' || existing.reminderSentAt) return { status: 'skipped', reason: 'already_reminded' };
  await prisma.taskAlert.update({ where: { taskId: task.id }, data: { reminderSentAt: new Date() } });
  await audit(task.id, 'ALERT_NO_OWNER_REMINDER', `still no owner — release manager reminded (${config.alerts.releaseManager})`);
  await tellManager(task, 'no_owner_reminder');
  return { status: 'sent' };
}

/**
 * Start-time alert: one email per task to its owner, from the company mailbox.
 *   - no owner            → NO_OWNER, release manager told (never guess an address)
 *   - non-company address → BLOCKED_DOMAIN, release manager told
 *   - send error          → RETRYING (BullMQ retries); on the last attempt FAILED + manager told
 */
async function sendStartAlert(job: Job<EmailJobPayload>, task: AlertTask, log: typeof logger): Promise<EmailProcessorResult> {
  const taskId = task.id;
  const existing = await prisma.taskAlert.findUnique({ where: { taskId } });
  // One start alert per task per owner. After a reassignment the new owner gets
  // theirs; nobody gets the same alert twice. A "no owner" / "outside the company"
  // record only counts while it is still true.
  const owner = task.assignedUser;
  const handled =
    !!existing &&
    ((owner && existing.notifiedUserIds.includes(owner.id)) ||
      existing.status === 'ACKNOWLEDGED' ||
      (existing.status === 'FAILED' && existing.recipient === owner?.email) ||
      (existing.status === 'NO_OWNER' && !owner) ||
      (existing.status === 'BLOCKED_DOMAIN' && existing.recipient === owner?.email));
  if (existing && handled) {
    log.info({ alertStatus: existing.status }, 'Alert already sent to this owner — one per task per owner');
    return { status: 'skipped', reason: 'already_alerted' };
  }

  if (!task.assignedUser) {
    await recordAlert(taskId, { status: 'NO_OWNER', recipient: config.alerts.releaseManager });
    await audit(taskId, 'ALERT_NO_OWNER', `no owner — release manager told (${config.alerts.releaseManager})`);
    await tellManager(task, 'no_owner');
    return { status: 'skipped', reason: 'no_owner' };
  }

  const to = task.assignedUser.email;
  if (!domainAllowed(to)) {
    await recordAlert(taskId, { status: 'BLOCKED_DOMAIN', recipient: to });
    await audit(taskId, 'ALERT_BLOCKED_DOMAIN', `not sent to ${to} — outside company domains; release manager told`);
    await tellManager(task, 'blocked_domain', to);
    return { status: 'skipped', reason: 'blocked_domain' };
  }

  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;
  let messageId: string;
  try {
    const { subject, html } = buildStartAlert(task);
    messageId = (await sendMailInternal(to, subject, html, 'START-TIME ALERT SENT', config.alerts.replyTo)).messageId;
  } catch (err: unknown) {
    // Only a failed SEND is retried.
    const message = err instanceof Error ? err.message : String(err);
    const final = attempt >= maxAttempts;
    await recordAlert(taskId, { status: final ? 'FAILED' : 'RETRYING', recipient: to, attempts: attempt, lastError: message.slice(0, 500) });
    await audit(taskId, final ? 'ALERT_FAILED' : 'ALERT_RETRY', `to=${to} attempt ${attempt} of ${maxAttempts}: ${message.slice(0, 200)}`);
    if (final) await tellManager(task, 'failed', message.slice(0, 200));
    throw err;
  }

  // The email is out. If saving that fails, log it but don't throw: a retry would
  // send the same email again (and later report a delivery failure that didn't happen).
  try {
    await prisma.taskAlert.upsert({
      where: { taskId },
      create: { taskId, status: 'SENT', recipient: to, sentAt: new Date(), attempts: attempt, messageId, notifiedUserIds: [task.assignedUser.id] },
      update: { status: 'SENT', recipient: to, sentAt: new Date(), attempts: attempt, lastError: null, messageId, notifiedUserIds: { push: task.assignedUser.id } },
    });
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), messageId, to }, 'Alert sent but its status could not be saved — not retrying');
  }
  await audit(taskId, 'EMAIL_SENT', `to=${to} attempt=${attempt} messageId=${messageId}`);
  log.info({ messageId, to }, 'Start-time alert sent');
  return { status: 'sent', messageId };
}

export = processor;
