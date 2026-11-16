import config from '../config';
import { escapeHtml, signAckToken } from './emailService';

// Start-time alert email ("your task is ready to start now"), following the
// DeployFlow Start-time alerts mockup. Inline styles only — email clients
// ignore <style> blocks.

export interface AlertTask {
  id: string;
  sequenceNumber: number;
  taskName: string;
  system: string;
  assignedTeam: string | null;
  plannedStartTime: Date | null;
  plannedEndTime: Date | null;
  notes: string | null;
  description: string | null;
  assignedUser: { id: string; email: string; name: string } | null;
  project: { code: string; name: string };
  dependsOn: Array<{ dependsOn: { sequenceNumber: number; taskName: string; actualEndTime: Date | null } }>;
}

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

function tzLabel(tz: string): string {
  if (tz === 'Asia/Kolkata') return 'IST';
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  const part = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? tz;
}

function hhmm(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function day(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

/** "22:00 IST (16:30 UTC) · Sat 17 Oct" */
export function formatWhen(d: Date | null, withDay = true): string {
  if (!d) return 'Not set';
  const tz = config.alerts.timeZone;
  const local = `${hhmm(d, tz)} ${tzLabel(tz)}`;
  const utc = tz === 'UTC' ? '' : ` (${hhmm(d, 'UTC')} UTC)`;
  return `${local}${utc}${withDay ? ` · ${day(d, tz)}` : ''}`;
}

export function taskCode(task: Pick<AlertTask, 'project' | 'sequenceNumber'>): string {
  return `${task.project.code}-${task.sequenceNumber}`;
}

/** The link works only for this task and owner, until 12 hours after the planned end. */
export function buildAlertAckUrl(task: AlertTask): string {
  const end = task.plannedEndTime?.getTime();
  const exp = end ? Math.max(end + TWELVE_HOURS, Date.now() + TWELVE_HOURS) : undefined;
  const token = signAckToken(task.id, { uid: task.assignedUser?.id, exp });
  return `${config.frontendUrl}/#/acknowledge?task_id=${task.id}&token=${token}`;
}

function shell(inner: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7fa;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e4e8ee;border-radius:14px;overflow:hidden">
<tr><td style="background:#0f172a;color:#ffffff;padding:14px 20px;font-weight:600;font-size:15px">DeployFlow</td></tr>
<tr><td style="padding:22px 20px">${inner}</td></tr>
<tr><td style="padding:14px 20px;background:#f8fafc;border-top:1px solid #e4e8ee;font-size:12.5px;color:#5f6c80">${footer}</td></tr>
</table></body></html>`;
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:4px 12px 4px 0;color:#5f6c80;font-size:14px;width:130px;vertical-align:top">${label}</td><td style="padding:4px 0;font-size:14px;font-weight:600">${value}</td></tr>`;
}

export function buildStartAlert(task: AlertTask): { subject: string; html: string; ackUrl: string } {
  const code = taskCode(task);
  const ackUrl = buildAlertAckUrl(task);
  const first = (task.assignedUser?.name ?? '').split(' ')[0] || 'there';
  const subject = `[DeployFlow] ${code} is ready to start — ${task.taskName}`;

  const done = task.dependsOn.length
    ? task.dependsOn
        .map((d) => {
          const at = d.dependsOn.actualEndTime ? ` — Completed at ${escapeHtml(formatWhen(d.dependsOn.actualEndTime, false))}` : ' — Completed';
          return `${escapeHtml(task.project.code)}-${d.dependsOn.sequenceNumber} · ${escapeHtml(d.dependsOn.taskName)}${at}`;
        })
        .join('<br>')
    : 'Nothing has to finish before this task.';

  const steps = (task.notes || task.description || '').trim();
  const notes = steps
    ? `<div style="margin-top:14px;font-size:13.5px;color:#3f4b5e"><b>Notes</b><div style="white-space:pre-line;margin-top:4px">${escapeHtml(steps)}</div></div>`
    : '';

  const inner = `
<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:#1e4fb8;background:#f0f6ff;border:1px solid #c9dcfb">Ready to start</span>
<h2 style="font-size:20px;margin:10px 0 0">${escapeHtml(code)} · ${escapeHtml(task.taskName)}</h2>
<p style="font-size:14.5px;color:#3f4b5e;margin:8px 0 0">Hi ${escapeHtml(first)}, it's time to start your task. Everything before it is finished.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px">
${row('Project', `${escapeHtml(task.project.name)} <span style="font-weight:500;color:#5f6c80">(${escapeHtml(task.project.code)})</span>`)}
${row('System · Team', `${escapeHtml(task.system)} · ${escapeHtml(task.assignedTeam || '—')}`)}
${row('Planned start', escapeHtml(formatWhen(task.plannedStartTime)))}
${row('Planned end', escapeHtml(formatWhen(task.plannedEndTime, false)))}
</table>
<div style="margin-top:16px;border:1px solid #bfe8d1;background:#eefaf3;border-radius:10px;padding:10px 12px;font-size:13.5px;color:#0b6b43"><b>✓ All earlier steps are done</b><br>${done}</div>
${notes}
<p style="margin:20px 0 0"><a href="${ackUrl}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px">Acknowledge &amp; start</a></p>
<p style="font-size:12px;color:#5f6c80;margin:10px 0 0">The button opens a DeployFlow page — nothing changes until you click there. The link works only for this task and expires 12 hours after the planned end.</p>`;

  const footer = `You're getting this because you own ${escapeHtml(code)} in ${escapeHtml(task.project.name)}. Questions? Just reply — it goes to Release Management.`;
  return { subject, html: shell(inner, footer), ackUrl };
}

/** Sent to the release manager when an alert can't reach the owner. */
export function buildManagerNotice(
  task: AlertTask,
  reason: 'no_owner' | 'blocked_domain' | 'failed',
  detail?: string,
): { subject: string; html: string } {
  const code = taskCode(task);
  const subjects = {
    no_owner: `[DeployFlow] ${code} is ready but has no owner`,
    blocked_domain: `[DeployFlow] ${code} is ready — owner's address is outside the company`,
    failed: `[DeployFlow] Alert for ${code} could not be delivered`,
  };
  const explain = {
    no_owner: 'This task reached its start time and everything before it is done, but nobody is assigned. DeployFlow never guesses an address, so please make sure someone picks it up.',
    blocked_domain: `The owner's address (${escapeHtml(detail ?? '')}) is not a company address, so DeployFlow did not email it. Please contact the owner directly.`,
    failed: `DeployFlow tried several times and could not deliver the alert${detail ? ` (${escapeHtml(detail)})` : ''}. Please contact the owner directly.`,
  };
  const inner = `
<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:#a8312a;background:#fff3f2;border:1px solid #f7cfca">Needs attention</span>
<h2 style="font-size:19px;margin:10px 0 0">${escapeHtml(code)} · ${escapeHtml(task.taskName)}</h2>
<p style="font-size:14.5px;color:#3f4b5e;margin:8px 0 0">${explain[reason]}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px">
${row('Project', escapeHtml(task.project.name))}
${row('Team', escapeHtml(task.assignedTeam || '—'))}
${row('Planned start', escapeHtml(formatWhen(task.plannedStartTime)))}
</table>
<p style="margin:18px 0 0"><a href="${config.frontendUrl}/#/timeline" style="color:#2563eb">Open the cutover timeline</a></p>`;
  return { subject: subjects[reason], html: shell(inner, 'Sent to Release Management by DeployFlow start-time alerts.') };
}
