import prisma from '../config/prisma';

/**
 * Recoverable email delivery.
 *
 * Before sending, a worker CLAIMS the email with one conditional UPDATE. The claim
 * records who it is for and when it was taken. It is granted only if:
 *   - the email hasn't been sent to that person yet,
 *   - the task is still in the right state AND still assigned to that person,
 *   - nobody else holds a live claim (a claim older than LEASE_MS is treated as
 *     abandoned: the worker that took it crashed).
 * The email is recorded as sent only after the provider accepted it, and only by the
 * worker that still holds the claim. A failed send releases the claim.
 *
 * Guarantee: at-least-once with duplicate suppression. A worker crash after the
 * provider accepted the email but before the database update is saved can still
 * lead to one repeat after the lease. No database design can rule that out with an
 * external email provider; the window is a few milliseconds.
 */
export const LEASE_MS = 5 * 60 * 1000;
const LEASE_SECONDS = LEASE_MS / 1000;

/** Thrown when a live claim is held by another worker: BullMQ retries the job later. */
export class ClaimBusyError extends Error {
  constructor(what: string) {
    super(`${what} is being sent by another worker right now - will retry`);
    this.name = 'ClaimBusyError';
  }
}

// ── Start-time alert (task_alerts row) ──────────────────────────────────────

/** Returns the claim time (the claim's identity) or null if the claim was refused. */
export async function claimStartAlert(taskId: string, ownerId: string, to: string): Promise<Date | null> {
  await prisma.taskAlert.createMany({ data: [{ taskId, status: 'SENDING', recipient: to }], skipDuplicates: true });
  const rows = await prisma.$queryRaw<Array<{ claimed_at: Date }>>`
    UPDATE task_alerts a
       SET claim_user_id = ${ownerId}, claimed_at = now(), status = 'SENDING', recipient = ${to}, updated_at = now()
     WHERE a.task_id = ${taskId}
       AND NOT (${ownerId} = ANY(a.notified_user_ids))
       AND a.status <> 'ACKNOWLEDGED'
       AND (a.claim_user_id IS NULL OR a.claimed_at < now() - make_interval(secs => ${LEASE_SECONDS}))
       AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = a.task_id AND t.assigned_user_id = ${ownerId} AND t.status = 'Triggered')
    RETURNING a.claimed_at`;
  return rows[0]?.claimed_at ?? null;
}

/** Why a start-alert claim was refused: decides between "skip" and "retry later". */
export async function whyStartAlertRefused(taskId: string, ownerId: string): Promise<'already_alerted' | 'owner_changed' | 'busy'> {
  const [alert, task] = await Promise.all([
    prisma.taskAlert.findUnique({ where: { taskId }, select: { status: true, notifiedUserIds: true } }),
    prisma.task.findUnique({ where: { id: taskId }, select: { status: true, assignedUserId: true } }),
  ]);
  if (alert && (alert.notifiedUserIds.includes(ownerId) || alert.status === 'ACKNOWLEDGED')) return 'already_alerted';
  if (!task || task.status !== 'Triggered' || task.assignedUserId !== ownerId) return 'owner_changed';
  return 'busy';
}

/** Record the send. Only the worker still holding the claim can do this. */
export async function completeStartAlert(taskId: string, ownerId: string, claimedAt: Date, data: { messageId: string; attempts: number }): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE task_alerts
       SET notified_user_ids = array_append(notified_user_ids, ${ownerId}),
           status = 'SENT', sent_at = now(), message_id = ${data.messageId}, attempts = ${data.attempts},
           last_error = NULL, claim_user_id = NULL, claimed_at = NULL, updated_at = now()
     WHERE task_id = ${taskId} AND claim_user_id = ${ownerId} AND claimed_at = ${claimedAt}`;
  return n === 1;
}

/** Give the claim back (send failed or the owner changed) so a retry can take it. */
export async function releaseStartAlert(taskId: string, ownerId: string, claimedAt: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE task_alerts SET claim_user_id = NULL, claimed_at = NULL, updated_at = now()
     WHERE task_id = ${taskId} AND claim_user_id = ${ownerId} AND claimed_at = ${claimedAt}`;
}

// ── Completion email (columns on tasks) ─────────────────────────────────────

export async function claimCompletion(taskId: string, ownerId: string): Promise<Date | null> {
  const now = new Date();
  const res = await prisma.task.updateMany({
    where: {
      id: taskId,
      status: 'Acknowledged',
      assignedUserId: ownerId,
      completionEmailSentAt: null,
      OR: [{ completionEmailStatus: null }, { completionEmailStatus: { not: 'FAILED' } }],
      AND: [{ OR: [{ completionEmailClaimedAt: null }, { completionEmailClaimedAt: { lt: new Date(now.getTime() - LEASE_MS) } }] }],
    },
    data: { completionEmailStatus: 'SENDING', completionEmailClaimedAt: now },
  });
  return res.count === 1 ? now : null;
}

export async function whyCompletionRefused(taskId: string, ownerId: string): Promise<'already_sent' | 'owner_changed' | 'busy'> {
  const t = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, assignedUserId: true, completionEmailSentAt: true, completionEmailStatus: true },
  });
  if (!t || t.completionEmailSentAt || t.completionEmailStatus === 'FAILED') return 'already_sent';
  if (t.status !== 'Acknowledged' || t.assignedUserId !== ownerId) return 'owner_changed';
  return 'busy';
}

export async function completeCompletion(taskId: string, claimedAt: Date): Promise<boolean> {
  const res = await prisma.task.updateMany({
    where: { id: taskId, completionEmailClaimedAt: claimedAt },
    data: { completionEmailStatus: 'SENT', completionEmailSentAt: new Date(), completionEmailClaimedAt: null },
  });
  return res.count === 1;
}

/** Release after a failed send; on the last attempt the email is marked FAILED (no more automatic sends). */
export async function releaseCompletion(taskId: string, claimedAt: Date, final: boolean): Promise<void> {
  await prisma.task.updateMany({
    where: { id: taskId, completionEmailClaimedAt: claimedAt },
    data: { completionEmailStatus: final ? 'FAILED' : null, completionEmailClaimedAt: null },
  });
}

/** Re-check just before handing the email to the provider. */
export async function stillOwnedBy(taskId: string, ownerId: string, status: string): Promise<boolean> {
  const t = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true, assignedUserId: true } });
  return !!t && t.status === status && t.assignedUserId === ownerId;
}
