import config from '../config';

// The worker is the only part that sends email, so it is the one source of truth
// for "who is this from / where do replies go". It publishes these to Redis and the
// API only displays them, so what the UI shows always matches the real sender.
export const MAIL_SETTINGS_KEY = 'tilli-go:mail-settings';

export function fromAddress(): string {
  if (config.microsoft.mailEnabled) return config.microsoft.mailFrom;
  return config.email.fromAddress || `noreply@${config.email.domain}`;
}

export function mailSettings() {
  return {
    fromName: config.email.fromName,
    fromAddress: fromAddress(),
    replyTo: config.alerts.replyTo,
    releaseManager: config.alerts.releaseManager,
    allowedDomains: config.alerts.allowedDomains,
    transport: config.microsoft.mailEnabled ? 'microsoft365' : config.smtp.host && config.smtp.user ? 'smtp' : 'mock',
  };
}
