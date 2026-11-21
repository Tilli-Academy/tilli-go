import { Queue } from 'bullmq';
import connection from '../config/redis';
import logger from '../config/logger';
import type { EmailJobPayload } from '../types';

const emailQueue = new Queue<EmailJobPayload>('email-queue', {
  connection,
});

export async function addEmailJob(data: EmailJobPayload): Promise<void> {
  // Per owner for start alerts, so a reassigned task can email its new owner.
  const jobId = `email-${data.taskId}-${data.type || 'triggered'}${data.ownerId ? `-${data.ownerId}` : ''}`;

  await emailQueue.add('send-email', data, {
    jobId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 7 * 86400 },
  });

  logger.info({ jobId, taskId: data.taskId }, 'Email job enqueued by worker');
}

export async function close(): Promise<void> {
  await emailQueue.close();
}
