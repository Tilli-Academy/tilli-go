import 'dotenv/config';
import logger from './src/config/logger';
import prisma from './src/config/prisma';
import { taskWorker } from './src/queues/taskQueue';
import { emailWorker } from './src/queues/emailQueue';
import * as emailProducer from './src/services/emailProducer';
import connection from './src/config/redis';
import { MAIL_SETTINGS_KEY, mailSettings } from './src/services/mailSettings';

logger.info('Tilli-go worker started');
// The worker is the one that sends, so it tells the API (via Redis) what it really uses.
async function publishMailSettings(): Promise<void> {
  try {
    await connection.set(MAIL_SETTINGS_KEY, JSON.stringify(mailSettings()));
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not publish mail settings');
  }
}
void publishMailSettings();
// Re-publish now and then, in case Redis evicted the key (it uses an LRU policy).
setInterval(() => void publishMailSettings(), 5 * 60_000).unref();
logger.info(
  { queues: ['task-queue', 'email-queue'] },
  'Listening for jobs'
);

// Graceful shutdown with 25s timeout (Docker sends SIGKILL after 30s)
const SHUTDOWN_TIMEOUT_MS = 25_000;

const shutdown = async (signal: string): Promise<void> => {
  logger.info(`${signal} received — shutting down worker`);

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await Promise.all([
      taskWorker.close(),
      emailWorker.close(),
      emailProducer.close(),
    ]);
    await prisma.$disconnect();
    logger.info('Worker shut down cleanly');
    process.exit(0);
  } catch (err: unknown) {
    logger.error(err, 'Error during worker shutdown');
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err: Error) => {
  logger.fatal(err, 'Uncaught exception in worker — shutting down');
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (err: unknown) => {
  logger.error(err, 'Unhandled rejection in worker');
});
