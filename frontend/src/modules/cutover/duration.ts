// Flexible cutover durations: 0:00 checkpoints, minutes, days, weeks, or N/A.
export const LONG_RUNNING_MS = 24 * 60 * 60 * 1000;

export type DurationKind = 'unscheduled' | 'no-estimate' | 'milestone' | 'timed' | 'long-running';

export function durationKind(start: string | null, end: string | null): DurationKind {
  if (!start) return 'unscheduled';
  if (!end) return 'no-estimate';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms === 0) return 'milestone';
  return ms >= LONG_RUNNING_MS ? 'long-running' : 'timed';
}

export function formatDuration(start: string | null, end: string | null): string {
  const kind = durationKind(start, end);
  if (kind === 'unscheduled') return '';
  if (kind === 'no-estimate') return 'N/A';
  if (kind === 'milestone') return '0:00 checkpoint';
  let mins = Math.round((new Date(end!).getTime() - new Date(start!).getTime()) / 60000);
  if (mins < 0) return 'invalid';
  const wk = Math.floor(mins / 10080); mins -= wk * 10080;
  const d = Math.floor(mins / 1440); mins -= d * 1440;
  const h = Math.floor(mins / 60); const m = mins % 60;
  const parts = [wk && `${wk} wk`, d && `${d} d`, h && `${h} h`, m && `${m} min`].filter(Boolean);
  return parts.slice(0, 2).join(' ');
}
