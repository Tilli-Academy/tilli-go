import { Job } from 'bullmq';
import prisma from '../config/prisma';
import logger from '../config/logger';
import config from '../config';
import { sendCompletionEmail, sendMailInternal } from '../services/emailService';
import { buildManagerNotice, buildStartAlert, type AlertTask } from '../services/alertEmail';
import type { EmailJobPayload, EmailProcessorResult } from '../types';

/**
 * email-queue processor.
 *
 * Flow:
 *   1. Fetch task from DB (with assignedUser for email address)
 *   2. Idempotency: skip if task no longer Triggered
 *   3. Call sendEmail(task) — signs ack token, builds email, sends via nodemailer
 *   4. Audit log
 *
 * Retries are handled by BullMQ (5 attempts, exponential backoff).
 * The jobId "email-{taskId}-triggered" prevents duplicate enqueues.
 * The status check here prevents duplicate sends on retry after partial failure.
 */
const processor = async (job: Job<EmailJobPayload>): Promise<EmailProcessorResult> => {
  const { taskId, type } = job.data;
  const log = logger.child({ jobId: job.id, taskId, emailType: type });

  log.info('Processing email job');

  // ── 1. Fetch task ────────────────────────────────────────────────────
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: {
      assignedUser: { select: { id: true, email: true, name: true } },
    },
  });

  if (!task) {
    log.warn('Task not found — skipping email');
    return { status: 'skipped', reason: 'task_not_found' };
  }

  // ── 2. Route by email type ────────────────────────────────────────────
  if (type === 'completion') {
    // Completion emails are only sent for Acknowledged tasks
    if (task.status !== 'Acknowledged') {
      log.info(
        { currentStatus: task.status },
        'Task not Acknowledged — skipping completion email'
      );
      return { status: 'skipped', reason: 'status_moved_on' };
    }

    // Never guess an address from a team name, and only email company addresses.
    const to = task.assignedUser?.email;
    if (!to || !domainAllowed(to)) {
      log.info({ to: to ?? null }, 'No company owner address — skipping completion email');
      return { status: 'skipped', reason: to ? 'blocked_domain' : 'no_owner' };
    }

    const result = await sendCompletionEmail(task);

    try {
      await prisma.auditLog.create({
        data: {
          taskId,
          action: 'SYSTEM_EMAIL_SENT',
          field: null,
          oldValue: null,
          newValue: `type=completion to=${to} messageId=${result.messageId}`,
        },
      });
    } catch (auditErr: unknown) {
      log.error(
        { err: auditErr instanceof Error ? auditErr.message : String(auditErr), messageId: result.messageId },
        'Completion email sent but audit log write failed'
      );
    }

    log.info({ messageId: result.messageId }, 'Completion email sent successfully');
    return { status: 'sent', messageId: result.messageId };
  }

  // ── Default: start-time alert ───────────────────────────────────────
  if (task.status !== 'Triggered') {
    log.info({ currentStatus: task.status }, 'Task no longer in Triggered state — skipping email');
    return { status: 'skipped', reason: 'status_moved_on' };
  }
  return sendStartAlert(job, log);
};

const ALERT_TASK_INCLUDE = {
  assignedUser: { select: { id: true, email: true, name: true } },
  project: { select: { code: true, name: true } },
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
async function tellManager(task: AlertTask, reason: 'no_owner' | 'blocked_domain' | 'failed', detail?: string) {
  try {
    const { subject, html } = buildManagerNotice(task, reason, detail);
    await sendMailInternal(config.alerts.releaseManager, subject, html, 'RELEASE MANAGER NOTICE');
  } catch (err: unknown) {
    logger.error({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, 'Release manager notice failed');
  }
}

/**
 * Start-time alert: one email per task to its owner, from the company mailbox.
 *   - no owner            → NO_OWNER, release manager told (never guess an address)
 *   - non-company address → BLOCKED_DOMAIN, release manager told
 *   - send error          → RETRYING (BullMQ retries); on the last attempt FAILED + manager told
 */
async function sendStartAlert(job: Job<EmailJobPayload>, log: typeof logger): Promise<EmailProcessorResult> {
  const { taskId } = job.data;
  const task = (await prisma.task.findUnique({ where: { id: taskId }, include: ALERT_TASK_INCLUDE })) as AlertTask | null;
  if (!task) return { status: 'skipped', reason: 'task_not_found' };

  const existing = await prisma.taskAlert.findUnique({ where: { taskId } });
  if (existing && ['SENT', 'ACKNOWLEDGED', 'NO_OWNER', 'BLOCKED_DOMAIN', 'FAILED'].includes(existing.status)) {
    log.info({ alertStatus: existing.status }, 'Alert already handled — one alert per task');
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
  try {
    const { subject, html } = buildStartAlert(task);
    const result = await sendMailInternal(to, subject, html, 'START-TIME ALERT SENT', config.alerts.replyTo);
    await recordAlert(taskId, {
      status: 'SENT', recipient: to, sentAt: new Date(), attempts: attempt, lastError: null, messageId: result.messageId,
    });
    await audit(taskId, 'EMAIL_SENT', `to=${to} attempt=${attempt} messageId=${result.messageId}`);
    log.info({ messageId: result.messageId, to }, 'Start-time alert sent');
    return { status: 'sent', messageId: result.messageId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const final = attempt >= maxAttempts;
    await recordAlert(taskId, { status: final ? 'FAILED' : 'RETRYING', recipient: to, attempts: attempt, lastError: message.slice(0, 500) });
    await audit(taskId, final ? 'ALERT_FAILED' : 'ALERT_RETRY', `to=${to} attempt ${attempt} of ${maxAttempts}: ${message.slice(0, 200)}`);
    if (final) await tellManager(task, 'failed', message.slice(0, 200));
    throw err;
  }
}

export = processor;
