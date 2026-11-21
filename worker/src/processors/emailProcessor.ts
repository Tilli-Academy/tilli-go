import { Job } from 'bullmq';
import prisma from '../config/prisma';
import logger from '../config/logger';
import config from '../config';
import { sendCompletionEmail, sendMailInternal } from '../services/emailService';
import * as claims from '../services/deliveryClaims';
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

  if (type === 'completion') return sendCompletion(job, task, log);
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

type ManagerReason = 'no_owner' | 'no_owner_reminder' | 'blocked_domain' | 'failed';

/** Email the release manager. Throws if the send fails (so BullMQ can retry the job). */
async function notifyManager(task: AlertTask, reason: ManagerReason, detail?: string): Promise<void> {
  const { subject, html } = buildManagerNotice(task, reason, detail);
  await sendMailInternal(config.alerts.releaseManager, subject, html, 'RELEASE MANAGER NOTICE');
}

/** Best effort: tell the release manager alongside another outcome. Never throws. */
async function tellManager(task: AlertTask, reason: ManagerReason, detail?: string) {
  try {
    await notifyManager(task, reason, detail);
  } catch (err: unknown) {
    logger.error({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, 'Release manager notice failed');
  }
}

async function sendCompletion(job: Job<EmailJobPayload>, task: AlertTask & { status: string }, log: typeof logger): Promise<EmailProcessorResult> {
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
  const ownerId = task.assignedUser!.id;

  // Claim (one conditional update: still Acknowledged, still this owner, not sent,
  // no live claim). See services/deliveryClaims.ts for the delivery guarantee.
  const claimedAt = await claims.claimCompletion(task.id, ownerId);
  if (!claimedAt) {
    const why = await claims.whyCompletionRefused(task.id, ownerId);
    if (why === 'busy') throw new claims.ClaimBusyError('Completion email');
    if (why === 'owner_changed') {
      // Reassigned (or moved on) after we loaded the task: a retry reloads it.
      throw new Error('Task changed while preparing the completion email - retrying with fresh data');
    }
    log.info('Completion email already sent — skipping');
    return { status: 'skipped', reason: 'already_sent' };
  }

  const attempt = job.attemptsMade + 1;
  const final = attempt >= (job.opts.attempts ?? 1);
  if (!(await claims.stillOwnedBy(task.id, ownerId, 'Acknowledged'))) {
    await claims.releaseCompletion(task.id, claimedAt, false);
    throw new Error('Task changed just before sending the completion email - retrying with fresh data');
  }
  let result: Awaited<ReturnType<typeof sendCompletionEmail>>;
  try {
    result = await sendCompletionEmail(task, to);
  } catch (err) {
    // Give the claim back so the BullMQ retry can send it (FAILED after the last attempt).
    await claims.releaseCompletion(task.id, claimedAt, final);
    throw err;
  }
  // Recorded as sent only now, after the provider accepted it.
  if (!(await claims.completeCompletion(task.id, claimedAt))) {
    log.warn('Completion email sent, but the claim had expired and was taken over — a repeat is possible');
  }
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
  return sendManagerNotice(task, 'notice', 'ALERT_NO_OWNER', `due but no owner — held, release manager told (${config.alerts.releaseManager})`, log);
}

/**
 * Release Management notice (no owner) or its one reminder, sent at most once:
 * claim (atomic, 5-min lease) → send → record. A failed send releases the claim and
 * throws, so BullMQ retries; a live claim held by another worker makes this job retry
 * later; a crashed worker's claim expires. If the email went out but recording it
 * fails, the error is logged and not retried (a retry would send it again).
 */
async function sendManagerNotice(
  task: AlertTask,
  which: claims.ManagerNotice,
  auditAction: string,
  auditText: string,
  log: typeof logger,
): Promise<EmailProcessorResult> {
  const to = config.alerts.releaseManager;
  const claimedAt = await claims.claimManagerNotice(task.id, which, to);
  if (!claimedAt) {
    const why = await claims.whyManagerNoticeRefused(task.id, which);
    if (why === 'busy') throw new claims.ClaimBusyError('Release Management notice');
    log.info({ why }, 'Release Management notice not needed');
    return { status: 'skipped', reason: why === 'already_sent' ? (which === 'notice' ? 'already_alerted' : 'already_reminded') : why };
  }
  try {
    await notifyManager(task, which === 'notice' ? 'no_owner' : 'no_owner_reminder');
  } catch (err) {
    await claims.releaseManagerNotice(task.id, which, claimedAt);
    throw err;
  }
  let outcome: Awaited<ReturnType<typeof claims.completeManagerNotice>> | 'record_failed';
  try {
    outcome = await claims.completeManagerNotice(task.id, which, claimedAt, to);
  } catch (err: unknown) {
    outcome = 'record_failed';
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Notice sent but could not be recorded — not retrying');
  }
  if (outcome === 'claim_lost') log.warn('Notice sent, but the claim had expired and was taken over — a repeat is possible');
  if (outcome === 'owner_assigned') {
    // The email went out (audit says so), but the task has an owner now: no "no owner" record.
    log.info('Notice sent, but an owner was assigned meanwhile — not recorded as "no owner"');
    await audit(task.id, auditAction, `${auditText} (an owner was assigned while it was being sent)`);
    return { status: 'sent', reason: 'owner_assigned_meanwhile' };
  }
  await audit(task.id, auditAction, auditText);
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
  return sendManagerNotice(task, 'reminder', 'ALERT_NO_OWNER_REMINDER', `still no owner — release manager reminded (${config.alerts.releaseManager})`, log);
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
    // Same as the scheduler's no-owner notice: sent once, recorded only after it went out.
    const r = await sendManagerNotice(task, 'notice', 'ALERT_NO_OWNER', `no owner — release manager told (${config.alerts.releaseManager})`, log);
    return r.status === 'sent' ? { status: 'skipped', reason: 'no_owner' } : r;
  }

  const to = task.assignedUser.email;
  if (!domainAllowed(to)) {
    await recordAlert(taskId, { status: 'BLOCKED_DOMAIN', recipient: to });
    await audit(taskId, 'ALERT_BLOCKED_DOMAIN', `not sent to ${to} — outside company domains; release manager told`);
    await tellManager(task, 'blocked_domain', to);
    return { status: 'skipped', reason: 'blocked_domain' };
  }

  // Claim before sending (see services/deliveryClaims.ts). Granted only if this owner
  // hasn't been emailed, the task is still Triggered AND still theirs, and no other
  // worker holds a live claim. An abandoned claim (crashed worker) expires after 5 min.
  const ownerId = task.assignedUser.id;
  const claimedAt = await claims.claimStartAlert(taskId, ownerId, to);
  if (!claimedAt) {
    const why = await claims.whyStartAlertRefused(taskId, ownerId);
    if (why === 'busy') throw new claims.ClaimBusyError('Start-time alert');
    log.info({ why }, why === 'owner_changed' ? 'Task reassigned or moved on — not alerting the old owner' : 'Alert already sent to this owner');
    return { status: 'skipped', reason: why };
  }

  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;
  // Last check right before handing the email over: never alert an outdated owner.
  if (!(await claims.stillOwnedBy(taskId, ownerId, 'Triggered'))) {
    await claims.releaseStartAlert(taskId, ownerId, claimedAt);
    log.info('Task reassigned while preparing the alert — not sent to the old owner');
    return { status: 'skipped', reason: 'owner_changed' };
  }
  let messageId: string;
  try {
    const { subject, html } = buildStartAlert(task);
    messageId = (await sendMailInternal(to, subject, html, 'START-TIME ALERT SENT', config.alerts.replyTo)).messageId;
  } catch (err: unknown) {
    // Only a failed SEND is retried. Give the claim back so the retry can take it.
    const message = err instanceof Error ? err.message : String(err);
    const final = attempt >= maxAttempts;
    await claims.releaseStartAlert(taskId, ownerId, claimedAt);
    await recordAlert(taskId, { status: final ? 'FAILED' : 'RETRYING', recipient: to, attempts: attempt, lastError: message.slice(0, 500) });
    await audit(taskId, final ? 'ALERT_FAILED' : 'ALERT_RETRY', `to=${to} attempt ${attempt} of ${maxAttempts}: ${message.slice(0, 200)}`);
    if (final) await tellManager(task, 'failed', message.slice(0, 200));
    throw err;
  }

  // The email is out: record it (only the claim holder can). If saving fails, log it
  // but don't throw: a BullMQ retry would send the same email again right away.
  try {
    if (!(await claims.completeStartAlert(taskId, ownerId, claimedAt, { messageId, attempts: attempt }))) {
      log.warn({ messageId, to }, 'Alert sent, but the claim had expired and was taken over — a repeat is possible');
    }
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), messageId, to }, 'Alert sent but its status could not be saved — not retrying');
  }
  await audit(taskId, 'EMAIL_SENT', `to=${to} attempt=${attempt} messageId=${messageId}`);
  log.info({ messageId, to }, 'Start-time alert sent');
  return { status: 'sent', messageId };
}

export = processor;
