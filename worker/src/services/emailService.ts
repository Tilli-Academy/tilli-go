import crypto from 'crypto';
import nodemailer from 'nodemailer';
import config from '../config';
import logger from '../config/logger';
import { sendEmailViaGraph } from './graphEmailService';
import { fromAddress } from './mailSettings';

// ── Transport ────────────────────────────────────────────────────────────────
// Real SMTP when credentials are configured, otherwise jsonTransport mock.
const transporter = config.smtp.host && config.smtp.user
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      // Well under the 5-minute delivery claim (services/deliveryClaims.ts), so a hung
      // send fails and is retried instead of outliving its claim.
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
    })
  : nodemailer.createTransport({ jsonTransport: true });

const isMock = !config.smtp.host || !config.smtp.user;

// ── Signed acknowledgement tokens (HMAC-SHA256) ─────────────────────────────

/** What a link may do: an acknowledge link can't be used to complete, and vice versa. */
export type LinkKind = 'ack' | 'complete';

export function signAckToken(taskId: string, opts: { kind: LinkKind; uid?: string; exp?: number }): string {
  const payload = Buffer.from(
    JSON.stringify({
      taskId,
      kind: opts.kind,
      exp: opts.exp ?? Date.now() + config.ackTokenExpiryMs,
      ...(opts.uid ? { uid: opts.uid } : {}),
    }),
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', config.ackTokenSecret)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
}

// ── HTML escaping ────────────────────────────────────────────────────────────

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Email building ───────────────────────────────────────────────────────────

interface TaskForEmail {
  id: string;
  plannedEndTime: Date | null;
  taskName: string;
  system: string;
  description: string | null;
  assignedTeam: string | null;
  assignedUser: { id: string; email: string; name: string } | null;
}

// ── Completion email ────────────────────────────────────────────────────────

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

/** Signed for this task AND its current owner; expires 12 h after the planned end. */
export function buildCompleteUrl(taskId: string, ownerId: string, plannedEndTime: Date | null): string {
  const end = plannedEndTime?.getTime();
  const exp = end ? Math.max(end + TWELVE_HOURS, Date.now() + TWELVE_HOURS) : undefined;
  const token = signAckToken(taskId, { kind: 'complete', uid: ownerId, exp });
  return `${config.frontendUrl}/#/complete?task_id=${taskId}&token=${token}`;
}

function buildCompletionEmailHtml(task: TaskForEmail, completeUrl: string): string {
  return [
    `<h2>Task Ready for Completion: ${escapeHtml(task.taskName)}</h2>`,
    `<p><strong>System:</strong> ${escapeHtml(task.system)}</p>`,
    `<p><strong>Team:</strong> ${escapeHtml(task.assignedTeam || 'Unassigned')}</p>`,
    task.description
      ? `<p><strong>Description:</strong> ${escapeHtml(task.description)}</p>`
      : '',
    '<br/>',
    `<p><a href="${completeUrl}" style="padding:10px 20px;background:#16a34a;color:#fff;text-decoration:none;border-radius:4px;">Mark as completed</a></p>`,
    `<p style="color:#666;font-size:12px;">Link expires 12 hours after the planned end.</p>`,
    `<p style="color:#666;font-size:12px;">Or copy this link: ${completeUrl}</p>`,
  ].join('\n');
}

// ── Main interface ───────────────────────────────────────────────────────────

export interface EmailResult {
  messageId: string;
}

// ── Shared send logic ────────────────────────────────────────────────────────

export async function sendMailInternal(
  to: string,
  subject: string,
  html: string,
  logLabel: string,
  replyTo?: string,
): Promise<EmailResult> {
  if (config.microsoft.mailEnabled) {
    const messageId = await sendEmailViaGraph(to, subject, html, replyTo);
    return { messageId };
  }

  const info = await transporter.sendMail({
    from: `"${config.email.fromName}" <${fromAddress()}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });

  const messageId: string = isMock
    ? info.messageId || `mock-${Date.now()}`
    : info.messageId;

  logger.info(
    { to, subject, messageId, mock: isMock },
    isMock ? `MOCK ${logLabel}` : logLabel,
  );

  return { messageId };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** `to` is decided by the caller (the task owner's company address); never guessed here. */
export async function sendCompletionEmail(task: TaskForEmail, to: string): Promise<EmailResult> {
  if (!task.assignedUser) throw new Error('Completion email needs an owner');
  const subject = `[Tilli-go] Task ready for completion: ${task.taskName}`;
  const completeUrl = buildCompleteUrl(task.id, task.assignedUser.id, task.plannedEndTime);
  const html = buildCompletionEmailHtml(task, completeUrl);
  return sendMailInternal(to, subject, html, 'COMPLETION EMAIL SENT');
}

export { transporter };
