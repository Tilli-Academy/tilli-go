import redis from '../../config/redis';
import logger from '../../config/logger';

// The worker sends every email, so it is the only place the sender, reply-to and
// release-manager address are defined. It publishes them to Redis on start-up and
// the API just shows them: the UI can't drift from the real sender.
const MAIL_SETTINGS_KEY = 'tilli-go:mail-settings';

export interface MailSettings {
  fromName: string;
  fromAddress: string;
  replyTo: string;
  releaseManager: string;
  allowedDomains: string[];
  transport: 'microsoft365' | 'smtp' | 'mock';
}

/** null when the worker hasn't started yet. */
export async function readMailSettings(): Promise<MailSettings | null> {
  try {
    const raw = await redis.get(MAIL_SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as MailSettings) : null;
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not read mail settings');
    return null;
  }
}

export const alertSettings = {
  demoTools: process.env.DEMO_TOOLS === 'true',
};
