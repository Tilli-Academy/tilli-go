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
          await prisma.task.update({
            where: { id: task.id },
            data: { status: 'Pending' },
          });
          await prisma.auditLog.create({
            data: {
              taskId: task.id,
              action: 'UPDATED',
              field: 'status',
              oldValue: 'Blocked',
              newValue: 'Pending',
            },
          });
          unblocked++;
          logger.info({ taskId: task.id }, 'Task unblocked → Pending');
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
          await prisma.task.update({
            where: { id: task.id },
            data: { status: 'Blocked' },
          });
          await prisma.auditLog.create({
            data: {
              taskId: task.id,
              action: 'UPDATED',
              field: 'status',
              oldValue: 'Pending',
              newValue: 'Blocked',
            },
          });
          blocked++;
          logger.info(
            { taskId: task.id, blockedBy: depResult?.blockingDepIds },
            'Task blocked — dependencies not met'
          );
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
    // The task's current owner hasn't been emailed, nothing is sending right now
    // (no claim, or a claim abandoned by a crashed worker), and nothing has happened
    // for a whole lease: the job was lost. Queue a fresh one; the worker's claim
    // still prevents a duplicate. FAILED / BLOCKED_DOMAIN / NO_OWNER are final.
    const lost = await prisma.$queryRaw<Array<{ task_id: string; owner_id: string }>>`
      SELECT a.task_id, t.assigned_user_id AS owner_id
        FROM task_alerts a
        JOIN tasks t ON t.id = a.task_id
        JOIN projects p ON p.id = t.project_id
       WHERE t.status = 'Triggered' AND p.start_alerts_enabled AND t.assigned_user_id IS NOT NULL
         AND NOT (t.assigned_user_id = ANY(a.notified_user_ids))
         AND a.status IN ('SENDING', 'RETRYING', 'SENT')
         AND (a.claim_user_id IS NULL OR a.claimed_at < ${leaseCutoff})
         AND a.updated_at < ${leaseCutoff}
       LIMIT 200`;
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
