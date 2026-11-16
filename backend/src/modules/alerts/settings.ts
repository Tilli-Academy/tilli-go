// Start-time alert settings shared by the API (for display) and mirrored in the
// worker (which actually sends). Keep the env names and defaults in sync with
// worker/src/config/index.ts.
const domain = process.env.EMAIL_DOMAIN || 'tilli.pro';

export const alertSettings = {
  fromAddress: process.env.EMAIL_FROM_ADDRESS || `deployflow-notifications@${domain}`,
  replyTo: process.env.ALERT_REPLY_TO || `release-management@${domain}`,
  releaseManager: process.env.ALERT_RELEASE_MANAGER_EMAIL || `release-management@${domain}`,
  timeZone: process.env.ALERT_TIMEZONE || 'Asia/Kolkata',
  allowedDomains: (process.env.ALERT_ALLOWED_DOMAINS || domain)
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  demoTools: process.env.DEMO_TOOLS === 'true',
};
