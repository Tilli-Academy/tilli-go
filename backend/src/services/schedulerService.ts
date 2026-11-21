import prisma from '../config/prisma';
import { canTaskExecute, canTasksExecuteBatch } from './dependencyService';
import { randomUUID } from 'node:crypto';
import { addTaskJob, addCompletionJob, addNoOwnerJob, addNoOwnerReminderJob, addRecoveryEmailJob, taskQueue } from './queueService';

/** Same as the worker's delivery-claim lease (worker/src/services/deliveryClaims.ts). */
export const NOTIFY_LEASE_MS = 5 * 60_000;

/** One reminder to Release Management this long after the no-owner notice (an Admin setting later). */
export const NO_OWNER_REMINDER_MS = 15 * 60_000;
import logger from '../config/logger';
import type { SchedulerStats } from '../types';

const INTERVAL_MS = 60_000; // 1 minute
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

// ── Stats (exposed for the status endpoint) ─────────────────────────────────

const stats: Omit<SchedulerStats, 'running'> = {
  lastRunAt: null,
  lastRunDurationMs: null,
  tasksEnqueued: 0,
  tasksCompletionEnqueued: 0,
  tasksBlocked: 0,
  tasksUnblocked: 0,
  errors: 0,
};

export function getStats(): SchedulerStats {
  return { ...stats, running: !!intervalHandle };
}

// ── Tick ─────────────────────────────────────────────────────────────────────
// Called every minute. Two phases:
//   1. Re-evaluate Blocked tasks → move back to Pending if deps now met
//   2. Find eligible Pending tasks → enqueue or mark Blocked

// ── Cluster-wide tick lock ──────────────────────────────────────────────────
// `running` only protects one process. If the API runs as several instances, each
// tick first takes a short Redis lock (SET NX PX); others skip that tick. A crashed
// instance's lock expires by itself; only the holder can release it.
const TICK_LOCK_KEY = 'tilli:scheduler:tick-lock';
const TICK_LOCK_MS = 55_000;
const RELEASE_IF_OWNER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function takeTickLock(): Promise<string | null> {
  const token = randomUUID();
  const redis = await taskQueue.client;
  return (await redis.set(TICK_LOCK_KEY, token, 'PX', TICK_LOCK_MS, 'NX')) === 'OK' ? token : null;
}

async function releaseTickLock(token: string): Promise<void> {
  const redis = await taskQueue.client;
  await redis.eval(RELEASE_IF_OWNER, 1, TICK_LOCK_KEY, token);
}

/**
 * Scheduler status move, only if the task still has the status it was read with
 * (someone may have marked it N/A, acknowledged it, etc. meanwhile). The history
 * entry is written in the same transaction, only when the move happened.
 * Returns false when the task had changed (nothing is saved).
 */
export async function moveStatus(taskId: string, from: string, to: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.task.updateMany({ where: { id: taskId, status: from }, data: { status: to } });
    if (moved.count === 0) {
      logger.info({ taskId, from, to }, 'Scheduler move skipped — task changed meanwhile');
      return false;
    }
    await tx.auditLog.create({ data: { taskId, action: 'UPDATED', field: 'status', oldValue: from, newValue: to } });
    return true;
  });
}

/**
 * Ready (Triggered) tasks whose start-time alert was lost and must be queued again
 * (see phase 4 of tick). Exported for the integration test.
 */
export async function findLostStartAlerts(now: Date): Promise<Array<{ task_id: string; owner_id: string }>> {
  const leaseCutoff = new Date(now.getTime() - NOTIFY_LEASE_MS);
  return prisma.$queryRaw<Array<{ task_id: string; owner_id: string }>>`
    SELECT t.id AS task_id, t.assigned_user_id AS owner_id
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      LEFT JOIN task_alerts a ON a.task_id = t.id
     WHERE t.status = 'Triggered' AND p.start_alerts_enabled AND t.assigned_user_id IS NOT NULL
       AND (
         (a.task_id IS NULL
            AND t.updated_at < ${leaseCutoff}
            AND t.updated_at > ${new Date(now.getTime() - 24 * 3600_000)})
         OR
         (a.task_id IS NOT NULL
            AND NOT (t.assigned_user_id = ANY(a.notified_user_ids))
            AND a.status IN ('SENDING', 'RETRYING', 'SENT')
            AND (a.claim_user_id IS NULL OR a.claimed_at < ${leaseCutoff})
            AND a.updated_at < ${leaseCutoff})
       )
     LIMIT 200`;
}

export async function tick(): Promise<void> {
  if (running) {
    logger.warn('Scheduler tick skipped — previous tick still running');
    return;
  }
  let lockToken: string | null;
  try {
    lockToken = await takeTickLock();
  } catch (err: unknown) {
    stats.errors++;
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Scheduler tick skipped — could not reach Redis for the tick lock');
    return;
  }
  if (!lockToken) {
    logger.info('Scheduler tick skipped — another API instance is running it');
    return;
  }

  running = true;
  const start = Date.now();
  let enqueued = 0;
  let completionEnqueued = 0;
  let blocked = 0;
  let unblocked = 0;
  let held = 0;
  let recovered = 0;

  try {
    // ── Phase 1: Unblock ────────────────────────────────────────────────
    // Blocked tasks whose deps are ALL Completed should return to Pending
    // so they become eligible in phase 2 (same tick or next).

    const blockedTasks = await prisma.task.findMany({
      where: { status: 'Blocked' },
      select: { id: true, taskName: true },
    });

    for (const task of blockedTasks) {
      try {
        const depCheck = await canTaskExecute(task.id);
        if (depCheck.executable) {
          if (await moveStatus(task.id, 'Blocked', 'Pending')) {
            unblocked++;
            logger.info({ taskId: task.id }, 'Task unblocked → Pending');
          }
        }
      } catch (err: unknown) {
        stats.errors++;
        logger.error(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'Unblock check failed'
        );
      }
    }

    // ── Phase 2: Evaluate eligible Pending tasks ────────────────────────
    // Conditions: status = Pending AND planned_start_time <= now

    const now = new Date();

    const candidates = await prisma.task.findMany({
      where: {
        status: 'Pending',
        plannedStartTime: { lte: now },
      },
      select: {
        id: true,
        taskName: true,
        system: true,
        assignedTeam: true,
        assignedUserId: true,
        alert: { select: { status: true, sentAt: true, reminderSentAt: true } },
      },
    });

    // Batch dependency check with cross-project validation
    const candidateIds = candidates.map((t) => t.id);
    const batchResults = await canTasksExecuteBatch(candidateIds);

    for (const task of candidates) {
      try {
        const depResult = batchResults.get(task.id);
        const executable = depResult?.executable ?? true;

        if (executable && !task.assignedUserId) {
          // A task with no owner never starts: hold it (stays Pending) and tell
          // Release Management once. It starts on the first tick after someone is assigned.
          const a = task.alert;
          if (a?.status !== 'NO_OWNER') await addNoOwnerJob(task);
          else if (!a.reminderSentAt && a.sentAt && now.getTime() - a.sentAt.getTime() >= NO_OWNER_REMINDER_MS) {
            await addNoOwnerReminderJob(task);
          }
          held++;
        } else if (executable) {
          await addTaskJob(task);
          enqueued++;
        } else {
          // Deps not met → mark Blocked
          if (await moveStatus(task.id, 'Pending', 'Blocked')) {
            blocked++;
            logger.info(
              { taskId: task.id, blockedBy: depResult?.blockingDepIds },
              'Task blocked — dependencies not met'
            );
          }
        }
      } catch (err: unknown) {
        stats.errors++;
        logger.error(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'Scheduler task processing failed'
        );
      }
    }

    // ── Phase 3: Completion — enqueue completion emails ─────────────────
    // Acknowledged tasks whose plannedEndTime has passed get ONE completion email.
    // Not yet sent, not given up on (FAILED), and nobody is sending it right now.
    const leaseCutoff = new Date(now.getTime() - NOTIFY_LEASE_MS);
    const completionCandidates = await prisma.task.findMany({
      where: {
        status: 'Acknowledged',
        plannedEndTime: { lte: now },
        completionEmailSentAt: null,
        OR: [{ completionEmailStatus: null }, { completionEmailStatus: { not: 'FAILED' } }],
        AND: [{ OR: [{ completionEmailClaimedAt: null }, { completionEmailClaimedAt: { lt: leaseCutoff } }] }],
      },
      select: {
        id: true,
        taskName: true,
        system: true,
        assignedTeam: true,
        assignedUserId: true,
        completionEmailClaimedAt: true,
        project: { select: { startAlertsEnabled: true } },
      },
    });

    for (const { completionEmailClaimedAt: abandoned, project, ...task } of completionCandidates) {
      try {
        if (abandoned) {
          // A worker crashed while sending: queue a fresh email job (the original
          // job ids are de-duplicated for 24 h).
          if (project.startAlertsEnabled) await addRecoveryEmailJob({ taskId: task.id, type: 'completion' }, String(abandoned.getTime()));
        } else {
          await addCompletionJob(task);
        }
        completionEnqueued++;
      } catch (err: unknown) {
        stats.errors++;
        logger.error(
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
          'Completion job enqueue failed'
        );
      }
    }

    // ── Phase 4: Recover start-time alerts ──────────────────────────────
    // A ready (Triggered) task with alerts on whose current owner hasn't been emailed,
    // where nothing is sending right now and nothing has happened for a whole lease:
    // the email job was lost. Two cases:
    //   - an alert row exists (claim abandoned by a crashed worker, retries used up
    //     while another worker held the claim, or a reassignment job lost);
    //   - NO alert row at all: the email job never made it into the queue. Only for
    //     tasks changed in the last 24 h, so tasks that were triggered long ago (before
    //     alerts existed) don't get a surprise email.
    // Queue a fresh job; the worker's claim still prevents a duplicate.
    // FAILED / BLOCKED_DOMAIN / NO_OWNER are final.
    const lost = await findLostStartAlerts(now);
    const round = String(Math.floor(now.getTime() / NOTIFY_LEASE_MS));
    for (const row of lost) {
      try {
        await addRecoveryEmailJob({ taskId: row.task_id, type: 'triggered', ownerId: row.owner_id }, round);
        recovered++;
      } catch (err: unknown) {
        stats.errors++;
        logger.error({ taskId: row.task_id, err: err instanceof Error ? err.message : String(err) }, 'Alert recovery enqueue failed');
      }
    }

    const durationMs = Date.now() - start;
    stats.lastRunAt = now.toISOString();
    stats.lastRunDurationMs = durationMs;
    stats.tasksEnqueued += enqueued;
    stats.tasksCompletionEnqueued += completionEnqueued;
    stats.tasksBlocked += blocked;
    stats.tasksUnblocked += unblocked;

    if (enqueued > 0 || blocked > 0 || unblocked > 0 || completionEnqueued > 0 || recovered > 0) {
      logger.info(
        { enqueued, completionEnqueued, blocked, unblocked, heldNoOwner: held, recoveredAlerts: recovered, durationMs },
        'Scheduler tick completed'
      );
    }
  } catch (err: unknown) {
    stats.errors++;
    logger.error(err, 'Scheduler tick failed');
  } finally {
    running = false;
    await releaseTickLock(lockToken).catch((err: unknown) =>
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Scheduler tick lock not released (it expires by itself)'));
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function start(): void {
  if (intervalHandle) return;
  logger.info({ intervalMs: INTERVAL_MS }, 'Scheduler started');
  tick(); // run immediately on startup
  intervalHandle = setInterval(tick, INTERVAL_MS);
}

export function stop(): void {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
  logger.info('Scheduler stopped');
}
