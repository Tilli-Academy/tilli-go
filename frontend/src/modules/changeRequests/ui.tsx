import type { CrStatus } from './types';

export const STATUS_FLOW: CrStatus[] = ['NEW', 'ASSESS', 'SCHEDULED', 'IMPLEMENT', 'REVIEW', 'CLOSED'];

export const STATUS_META: Record<CrStatus, { label: string; hint: string; cls: string }> = {
  NEW: { label: 'New', hint: 'Request drafted', cls: 'bg-slate-100 text-slate-700 ring-slate-300' },
  ASSESS: { label: 'Assess & Authorize', hint: 'Impact/risk review, waiting for approval', cls: 'bg-amber-50 text-amber-800 ring-amber-300' },
  SCHEDULED: { label: 'Scheduled', hint: 'Approved - go-live date locked', cls: 'bg-sky-50 text-sky-800 ring-sky-300' },
  IMPLEMENT: { label: 'Implement', hint: 'Cutover / deployment in progress', cls: 'bg-indigo-50 text-indigo-800 ring-indigo-300' },
  REVIEW: { label: 'Review', hint: 'Post-go-live checks', cls: 'bg-violet-50 text-violet-800 ring-violet-300' },
  CLOSED: { label: 'Closed', hint: 'Live and verified', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-300' },
  CANCELLED: { label: 'Cancelled', hint: 'Withdrawn', cls: 'bg-rose-50 text-rose-700 ring-rose-300' },
};

export function StatusPill({ status }: { status: CrStatus }) {
  const m = STATUS_META[status];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${m.cls}`}>{m.label}</span>;
}

const PRIORITY: Record<string, string> = {
  Critical: 'bg-rose-600 text-white',
  High: 'bg-orange-100 text-orange-800',
  Medium: 'bg-yellow-100 text-yellow-800',
  Low: 'bg-slate-100 text-slate-600',
};
export function PriorityTag({ priority }: { priority: string }) {
  return <span className={`whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${PRIORITY[priority] ?? ''}`}>{priority}</span>;
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

export function Level({ label, value }: { label: string; value: string }) {
  const c = value === 'High' ? 'text-rose-600' : value === 'Medium' ? 'text-amber-600' : 'text-emerald-600';
  return <span className="text-xs text-text-secondary">{label} <b className={c}>{value}</b></span>;
}

export const crNo = (n: number) => `CR-${n}`;
export const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '-';
export const fmtDateTime = (d: string) => new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export function relDays(d: string) {
  const a = new Date(d); a.setUTCHours(0, 0, 0, 0);
  const b = new Date(); b.setUTCHours(0, 0, 0, 0);
  const n = Math.round((a.getTime() - b.getTime()) / 86400000);
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
