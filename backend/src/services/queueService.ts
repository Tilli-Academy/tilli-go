import { Queue } from 'bullmq';
import config from '../config';
import logger from '../config/logger';
import type { TaskJobPayload, TaskJobInput, EmailJobPayload } from '../types';

// BullMQ manages its own connections internally — pass config, not a
// shared IORedis instance, so each Queue gets an independent connection.
const redisOpts = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  tls: config.redis.tls ? {} : undefined,
};

export const taskQueue = new Queue<TaskJobPayload>('task-queue', { connection: redisOpts });
export const emailQueue = new Queue<EmailJobPayload>('email-queue', { connection: redisOpts });

/**
 * Enqueue a task for the worker to transition Pending → Triggered.
 * jobId = task UUID so BullMQ silently de-duplicates if the same task
 * is pushed again before the worker picks it up.
 */
export async function addTaskJob(task: TaskJobInput): Promise<void> {
  const jobId = `task-trigger-${task.id}`;

  await taskQueue.add(
    'process-task',
    {
      taskId: task.id,
      taskName: task.taskName,
      system: task.system,
      assignedTeam: task.assignedTeam,
      assignedUserId: task.assignedUserId,
    },
    {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 86400 },   // keep 24h
      removeOnFail: { age: 7 * 86400 },   // keep 7d
    }
  );

  logger.info({ jobId, taskId: task.id }, 'Task job enqueued');
}

/**
 * Enqueue an email for the worker to send.
 * Called by the worker's task-processor after transitioning a task,
 * NOT by the scheduler or API.
 */
export async function addEmailJob(data: EmailJobPayload): Promise<void> {
  const jobId = `email-${data.taskId}-${data.type || 'notify'}`;

  await emailQueue.add(
    'send-email',
    data,
    {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 7 * 86400 },
    }
  );

  logger.info({ jobId, taskId: data.taskId }, 'Email job enqueued');
}

/**
 * Re-send an email whose delivery claim was abandoned (a worker crashed mid-send).
 * The jobId is new per recovery round, so BullMQ's 24 h de-duplication of the
 * original job can't swallow it; the worker's claim still prevents duplicates.
 */
export async function addRecoveryEmailJob(data: EmailJobPayload, round: string): Promise<void> {
  const jobId = `email-${data.taskId}-${data.type || 'notify'}${data.ownerId ? `-${data.ownerId}` : ''}-r${round}`;
  await emailQueue.add('send-email', data, {
    jobId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 7 * 86400 },
  });
  logger.warn({ jobId, taskId: data.taskId }, 'Abandoned email delivery re-queued');
}

/**
 * Enqueue a completion job for the worker to send a completion email.
 * Called by the scheduler when an Acknowledged task's plannedEndTime has passed.
 */
export async function addCompletionJob(task: TaskJobInput): Promise<void> {
  const jobId = `task-complete-${task.id}`;

  await taskQueue.add(
    'process-completion',
    {
      taskId: task.id,
      taskName: task.taskName,
      system: task.system,
      assignedTeam: task.assignedTeam,
      assignedUserId: task.assignedUserId,
    },
    {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 7 * 86400 },
    }
  );

  logger.info({ jobId, taskId: task.id }, 'Completion job enqueued');
}

/**
 * A due task has no owner: the worker keeps it Pending and tells Release Management.
 * One job per task (deterministic jobId); the worker also skips if it already told them.
 */
export async function addNoOwnerJob(task: TaskJobInput): Promise<void> {
  const jobId = `task-no-owner-${task.id}`;
  await taskQueue.add(
    'process-no-owner',
    { taskId: task.id, taskName: task.taskName, system: task.system, assignedTeam: task.assignedTeam, assignedUserId: null },
    { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 86400 }, removeOnFail: { age: 7 * 86400 } },
  );
  logger.info({ jobId, taskId: task.id }, 'No-owner job enqueued');
}

function taskJob(name: string, jobId: string, task: TaskJobInput) {
  return taskQueue.add(
    name,
    { taskId: task.id, taskName: task.taskName, system: task.system, assignedTeam: task.assignedTeam, assignedUserId: task.assignedUserId },
    { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 86400 }, removeOnFail: { age: 7 * 86400 } },
  );
}

/** Still no owner 15 min after the first notice: one reminder (one job per task). */
export async function addNoOwnerReminderJob(task: TaskJobInput): Promise<void> {
  await taskJob('process-no-owner-reminder', `task-no-owner-reminder-${task.id}`, task);
  logger.info({ taskId: task.id }, 'No-owner reminder job enqueued');
}

/** A ready task got a new owner: the worker emails them (one job per task per owner). */
export async function addReassignedJob(task: TaskJobInput): Promise<void> {
  await taskJob('process-reassigned', `task-reassigned-${task.id}-${task.assignedUserId}`, task);
  logger.info({ taskId: task.id, ownerId: task.assignedUserId }, 'Reassigned-task job enqueued');
}

export async function close(): Promise<void> {
  await taskQueue.close();
  await emailQueue.close();
}
