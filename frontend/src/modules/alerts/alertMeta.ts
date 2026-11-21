import { timeIn } from '../../utils/zoneTime';
// Start-time alert statuses (set by the worker) → how they look everywhere.
export interface TaskAlertInfo {
  status: string;
  recipient: string | null;
  sentAt: string | null;
  acknowledgedAt: string | null;
  attempts?: number;
  lastError?: string | null;
}

export const ALERT_META: Record<string, { label: string; icon: string; cls: string; hint: string }> = {
  SENT: { label: 'Awaiting acknowledgement', icon: '✉', cls: 'text-amber-800 bg-amber-50 border-amber-200', hint: 'Owner emailed; waiting for them to click.' },
  ACKNOWLEDGED: { label: 'Acknowledged', icon: '✓', cls: 'text-violet-800 bg-violet-50 border-violet-200', hint: 'Owner confirmed they started.' },
  NO_OWNER: { label: 'On hold — no owner', icon: '!', cls: 'text-rose-800 bg-rose-50 border-rose-200', hint: 'Starts once someone is assigned. Release manager told.' },
  BLOCKED_DOMAIN: { label: 'Not sent — outside company', icon: '✕', cls: 'text-rose-800 bg-rose-50 border-rose-200', hint: 'Only company addresses get alerts. Release manager told.' },
  SENDING: { label: 'Sending…', icon: '✉', cls: 'text-amber-800 bg-amber-50 border-amber-200', hint: 'The email is being sent now.' },
  RETRYING: { label: 'Failed — retrying', icon: '↻', cls: 'text-rose-800 bg-rose-50 border-rose-200', hint: 'Trying again automatically.' },
  FAILED: { label: 'Failed', icon: '✕', cls: 'text-rose-800 bg-rose-50 border-rose-200', hint: 'All retries used. Release manager told.' },
};

export function alertLabel(alert: TaskAlertInfo | null | undefined, status?: string): { label: string; icon: string; cls: string; hint: string } {
  if (alert && ALERT_META[alert.status]) return ALERT_META[alert.status]!;
  if (status === 'Blocked') return { label: 'Not sent yet — waiting on earlier step', icon: '…', cls: 'text-text-secondary bg-surface-hover border-border', hint: 'Sent as soon as everything before it is done.' };
  if (status === 'Completed') return { label: '—', icon: '', cls: 'text-text-muted border-transparent', hint: '' };
  return { label: 'Not sent yet', icon: '○', cls: 'text-text-secondary bg-surface-hover border-border', hint: 'Sent when the planned start arrives.' };
}

/** "21:00" in the project's zone (the Tasks grid still passes none: browser time, like its other columns) */
export const hhmm = (s: string | null | undefined, tz?: string) =>
  s ? timeIn(s, tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone) : '';
