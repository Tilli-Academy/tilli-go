import type { CrStatus, ListValue } from './types';
import { DEFAULT_TIME_ZONE, dateTimeIn, dayKeyIn, zoneLabel } from '../../utils/zoneTime';

export const STATUS_FLOW: CrStatus[] = ['NEW', 'ASSESS', 'SCHEDULED', 'IMPLEMENT', 'REVIEW', 'CLOSED'];

export const STATUS_META: Record<CrStatus, { label: string; hint: string; cls: string }> = {
  NEW: { label: 'New', hint: 'Request drafted', cls: 'bg-slate-100 text-slate-700 ring-slate-300' },
  ASSESS: { label: 'Assess & Authorize', hint: 'Impact/risk review, waiting for approval', cls: 'bg-amber-50 text-amber-800 ring-amber-300' },
  SCHEDULED: { label: 'Scheduled', hint: 'Approved - go-live date locked', cls: 'bg-sky-50 text-sky-800 ring-sky-300' },
  IMPLEMENT: { label: 'Implement', hint: 'Cutover / deployment in progress', cls: 'bg-indigo-50 text-indigo-800 ring-indigo-300' },
  REVIEW: { label: 'Review', hint: 'Post-go-live checks', cls: 'bg-violet-50 text-violet-800 ring-violet-300' },
  CLOSED: { label: 'Closed', hint: 'Live and verified, or rejected', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-300' },
  CANCELLED: { label: 'Cancelled', hint: 'Withdrawn', cls: 'bg-rose-50 text-rose-700 ring-rose-300' },
};

export function StatusPill({ status }: { status: CrStatus }) {
  const m = STATUS_META[status];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${m.cls}`}>{m.label}</span>;
}

/** A list value as a small tag in its admin-set colour (tinted background, coloured text). */
export function ValueTag({ value, solid }: { value: ListValue | null | undefined; solid?: boolean }) {
  if (!value) return null;
  const c = value.color;
  const style = c ? (solid ? { background: c, color: '#fff' } : { background: `${c}1a`, color: c }) : undefined;
  return (
    <span style={style} title={value.active ? undefined : 'No longer offered'}
      className={`whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${c ? '' : 'bg-surface-hover text-text-secondary'} ${value.active ? '' : 'opacity-70 line-through decoration-1'}`}>
      {value.label}
    </span>
  );
}
export function PriorityTag({ priority }: { priority: ListValue | null }) {
  return <ValueTag value={priority} />;
}

const COLORS = ['bg-blue-600', 'bg-emerald-600', 'bg-violet-600', 'bg-amber-600', 'bg-rose-600', 'bg-cyan-700'];
export function Avatar({ name, small }: { name: string; small?: boolean }) {
  const initials = name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  const c = COLORS[Array.from(name).reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length];
  return (
    <span title={name} className={`inline-flex flex-shrink-0 items-center justify-center rounded-full font-bold text-white ${c} ${small ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs'}`}>
      {initials}
    </span>
  );
}

/** Risk / impact: fixed key, label and colour from the risk list. */
export function Level({ label, value, risk }: { label: string; value: string | null; risk: ListValue[] }) {
  if (!value) return null;
  const v = risk.find((r) => r.key === value);
  return <span className="text-xs text-text-secondary">{label} <b style={{ color: v?.color ?? undefined }}>{v?.label ?? value}</b></span>;
}

export const crNo = (n: number) => `CR-${n}`;
export const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '-';
/** The CR's zone: its project's, else the default (US Central). */
export const crZone = (cr: { project: { timeZone?: string } | null }) => cr.project?.timeZone ?? DEFAULT_TIME_ZONE;
/** Deployment date and time in the CR's zone: "21 Nov 2026, 21:00 CST" */
export const fmtGoLive = (d: string, timeZone: string) => `${dateTimeIn(d, timeZone)} ${zoneLabel(timeZone, d)}`;
export const fmtDateTime = (d: string) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
/** "in 3 days" — calendar days in the given zone (date-only fields use UTC). */
export function relDays(d: string, timeZone = 'UTC') {
  const a = Date.parse(dayKeyIn(d, timeZone));
  const b = Date.parse(dayKeyIn(Date.now(), timeZone));
  const n = Math.round((a - b) / 86400000);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export const btnPrimary = 'inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2';
export const btnGhost = 'inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] bg-surface border border-border-strong text-text-primary text-sm font-medium rounded-lg hover:bg-surface-hover disabled:opacity-50 transition-colors cursor-pointer';
export const inputCls = 'w-full px-3 py-2 min-h-[40px] border border-border-strong rounded-md bg-surface text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';
export const labelCls = 'block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1';
export const card = 'bg-surface border border-border rounded-card shadow-card';
