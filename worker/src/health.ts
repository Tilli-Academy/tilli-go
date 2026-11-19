import fs from 'fs';
import connection from './config/redis';
import logger from './config/logger';
import type { Worker } from 'bullmq';

// Docker health check for the worker. The image has no redis-cli, so the old check
// always failed. Instead the worker writes a heartbeat file while it is really able
// to work (Redis connected, queue workers running); the health check only looks at
// how fresh that file is.
export const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE || '/tmp/worker-heartbeat';
const EVERY_MS = 15_000;

export function startHeartbeat(workers: Worker[]): NodeJS.Timeout {
  const beat = () => {
    const healthy = connection.status === 'ready' && workers.every((w) => w.isRunning());
    if (!healthy) return; // stale file → Docker marks the container unhealthy
    fs.writeFile(HEARTBEAT_FILE, new Date().toISOString(), (err) => {
      if (err) logger.warn({ err: err.message }, 'Could not write worker heartbeat');
    });
  };
  beat();
  const timer = setInterval(beat, EVERY_MS);
  timer.unref();
  return timer;
}
