import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getErrorMessage } from '../../services/api';
import { crApi } from './api';
import type { ChangeListItem, CrMeta, CrStatus } from './types';
import { Avatar, PriorityTag, STATUS_FLOW, STATUS_META, StatusPill, btnPrimary, card, crNo, fmtDate, inputCls, relDays, Level } from './ui';

const RECENT_DAYS = 30;

const selectCls = 'px-3 py-2 min-h-[40px] border border-border-strong rounded-md bg-surface text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export default function ChangeRequestList() {
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') === 'table' ? 'table' : 'board';
  const [items, setItems] = useState<ChangeListItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [meta, setMeta] = useState<CrMeta | null>(null);
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [showOlder, setShowOlder] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    crApi
      .list({ status: sp.get('status') ?? '', product: sp.get('product') ?? '', q: sp.get('q') ?? '', mine: sp.get('mine') === '1', conflicts: sp.get('conflicts') === '1', project: sp.get('project') ?? '' })
      .then((r) => { setItems(r.data.data); setCounts(r.data.counts); setError(null); })
      .catch((e) => setError(getErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [sp]);

  useEffect(load, [load]);
  useEffect(() => { crApi.meta().then((r) => setMeta(r.data)).catch(() => {}); }, []);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v); else next.delete(k);
    setSp(next, { replace: true });
  };

  const open = STATUS_FLOW.slice(0, 5).reduce((a, s) => a + (counts[s] ?? 0), 0);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const week = new Date(today.getTime() + 7 * 86400000);
  const live7 = items.filter((c) => STATUS_FLOW.slice(0, 5).includes(c.status) && new Date(c.plannedGoLive) >= today && new Date(c.plannedGoLive) < week).length;
  const conflicts = items.filter((c) => c.hasConflict).length;
  const filtered = ['status', 'product', 'q', 'mine', 'conflicts', 'project'].some((k) => sp.get(k));

  const tiles = [
    { label: 'Open changes', value: open, tone: 'text-primary bg-primary-light', on: () => setSp(new URLSearchParams(view === 'table' ? { view } : {})) },
    { label: 'Awaiting approval', value: counts.ASSESS ?? 0, tone: 'text-amber-700 bg-amber-50', on: () => setParam('status', 'ASSESS') },
    { label: 'Going live in 7 days', value: live7, tone: 'text-emerald-700 bg-emerald-50', on: undefined },
    { label: 'Date conflicts', value: conflicts, tone: conflicts ? 'text-rose-700 bg-rose-50' : 'text-text-secondary bg-surface-hover', on: () => setParam('conflicts', '1') },
  ];
  // Board: the open stages share the width; Closed (incl. cancelled) is a narrow strip until opened.
  const onlyStatus = sp.get('status') as CrStatus | null;
  const columns: CrStatus[] = onlyStatus ? [onlyStatus] : STATUS_FLOW;
  const inColumn = (s: CrStatus) => items.filter((c) => (s === 'CLOSED' && !onlyStatus ? c.status === 'CLOSED' || c.status === 'CANCELLED' : c.status === s));
  const recentCutoff = Date.now() - RECENT_DAYS * 86400000;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 sm:p-6 space-y-6 max-w-[1400px] mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-text-primary">Change Requests</h2>
          <Link to="/change-requests/new" className={btnPrimary}>+ New Change Request</Link>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {tiles.map((t) => (
            <button key={t.label} type="button" onClick={t.on} disabled={!t.on} className={`${card} p-4 text-left transition hover:shadow-card-hover disabled:cursor-default`}>
              <p className="text-sm font-medium text-text-secondary">{t.label}</p>
              <p className={`mt-2 inline-block rounded-lg px-2 text-2xl font-bold ${t.tone}`}>{t.value}</p>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={(e) => { e.preventDefault(); setParam('q', q.trim() || null); }} className="w-full sm:w-64">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, customer…  ⏎" className={inputCls} aria-label="Search" />
          </form>
          <select value={sp.get('product') ?? ''} onChange={(e) => setParam('product', e.target.value || null)} className={selectCls} aria-label="Product">
            <option value="">All products</option>
            {meta?.options.products.map((p) => <option key={p}>{p}</option>)}
          </select>
          <select value={sp.get('status') ?? ''} onChange={(e) => setParam('status', e.target.value || null)} className={selectCls} aria-label="Status">
            <option value="">All statuses</option>
            {(Object.keys(STATUS_META) as CrStatus[]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-text-secondary"><input type="checkbox" checked={sp.get('mine') === '1'} onChange={(e) => setParam('mine', e.target.checked ? '1' : null)} />Assigned to me</label>
          <label className="flex items-center gap-1.5 text-sm text-text-secondary"><input type="checkbox" checked={sp.get('conflicts') === '1'} onChange={(e) => setParam('conflicts', e.target.checked ? '1' : null)} />Conflicts only</label>
          {filtered && <button type="button" onClick={() => { setQ(''); setSp(new URLSearchParams(view === 'table' ? { view } : {})); }} className="text-sm text-primary hover:underline">Clear</button>}
          <div className="ml-auto inline-flex rounded-lg border border-border-strong bg-surface p-0.5 text-sm">
            {(['board', 'table'] as const).map((v) => (
              <button key={v} type="button" onClick={() => setParam('view', v === 'table' ? 'table' : null)} className={`rounded-md px-3 py-1.5 capitalize ${view === v ? 'bg-primary text-white' : 'text-text-secondary'}`}>{v}</button>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-destructive bg-destructive-light p-3 rounded">{error}</p>}
        {loading && items.length === 0 && <p className="text-sm text-text-muted">Loading…</p>}

        {view === 'board' ? (
          <div className="flex gap-3 overflow-x-auto pb-3">
            {columns.map((s) => {
              const all = inColumn(s);
              const closedCol = s === 'CLOSED' && !onlyStatus;
              const recent = closedCol && !showOlder ? all.filter((c) => new Date(c.updatedAt).getTime() >= recentCutoff) : all;
              const collapsed = !onlyStatus && (closedCol ? !showClosed : all.length === 0);
              const label = closedCol ? 'Closed' : STATUS_META[s].label;
              if (collapsed) {
                return (
                  <button key={s} type="button" disabled={!closedCol} onClick={() => setShowClosed(true)}
                    title={closedCol ? `Show recently closed (${all.length} closed in total)` : `${label}: empty`}
                    className="flex w-11 flex-none flex-col items-center gap-2 rounded-card bg-slate-100/80 py-3 text-text-secondary enabled:hover:bg-slate-200/80 disabled:cursor-default">
                    <span className="rounded-full bg-surface px-2 text-xs font-semibold">{all.length}</span>
                    <span className="text-sm font-semibold [writing-mode:vertical-rl]">{label}</span>
                  </button>
                );
              }
              return (
                <div key={s} className="min-w-[220px] flex-1 rounded-card bg-slate-100/80 p-2.5 lg:min-w-0">
                  <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
                    <span className="truncate text-sm font-semibold text-text-primary">{closedCol ? 'Recently closed' : label}</span>
                    <span className="flex items-center gap-1.5">
                      <span className="rounded-full bg-surface px-2 text-xs font-semibold text-text-secondary">{recent.length}</span>
                      {closedCol && <button type="button" onClick={() => { setShowClosed(false); setShowOlder(false); }} className="text-xs text-text-secondary hover:text-primary" title="Collapse" aria-label="Collapse closed">✕</button>}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {recent.map((c) => <Card key={c.id} c={c} />)}
                    {recent.length === 0 && <p className="py-6 text-center text-xs text-text-muted">{closedCol ? `None in the last ${RECENT_DAYS} days` : 'Empty'}</p>}
                    {closedCol && !showOlder && all.length > recent.length && (
                      <button type="button" onClick={() => setShowOlder(true)} className="w-full py-1 text-xs text-primary hover:underline">Show {all.length - recent.length} older</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={`${card} overflow-x-auto`}>
            <table className="w-full text-sm">
              <thead className="bg-surface-hover text-left text-xs uppercase tracking-wide text-text-secondary">
                <tr>{['CR', 'Title', 'Product', 'Status', 'Priority', 'Impact / Risk', 'Go-live', 'Project', 'Assignee'].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className={`border-t border-border hover:bg-surface-hover ${c.hasConflict ? 'bg-rose-50/60' : ''}`}>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{crNo(c.number)}</td>
                    <td className="px-4 py-3"><Link to={`/change-requests/${c.id}`} className="font-medium text-text-primary hover:text-primary">{c.title}</Link>{c.hasConflict && <span className="ml-2 text-xs font-semibold text-rose-600">⚠ conflict</span>}</td>
                    <td className="px-4 py-3">{c.product}</td>
                    <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                    <td className="px-4 py-3"><PriorityTag priority={c.priority} /></td>
                    <td className="px-4 py-3 whitespace-nowrap"><Level label="I" value={c.impact} /> · <Level label="R" value={c.risk} /></td>
                    <td className="px-4 py-3 whitespace-nowrap">{fmtDate(c.plannedGoLive)}<span className="block text-xs text-text-muted">{relDays(c.plannedGoLive)}</span></td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">{c.project ? <><span className="font-mono">{c.project.code}</span>{c.cutover && c.cutover.total > 0 && <span className="block text-text-muted">{c.cutover.completed}/{c.cutover.total} done</span>}</> : '-'}</td>
                    <td className="px-4 py-3"><span className="flex items-center gap-2 whitespace-nowrap"><Avatar name={c.assignee.name} small />{c.assignee.name}</span></td>
                  </tr>
                ))}
                {!loading && items.length === 0 && <tr><td colSpan={9} className="py-10 text-center text-text-muted">No change requests match these filters.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ c }: { c: ChangeListItem }) {
  const pct = c.cutover && c.cutover.total ? (c.cutover.completed / c.cutover.total) * 100 : 0;
  return (
    <Link to={`/change-requests/${c.id}`} className={`block rounded-lg border bg-surface p-3 shadow-card transition hover:-translate-y-0.5 hover:shadow-card-hover ${c.hasConflict ? 'border-rose-300' : 'border-border hover:border-primary/40'}`}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-mono text-xs text-text-muted">{crNo(c.number)}</span>
        <PriorityTag priority={c.priority} />
      </div>
      <p className="mb-2 text-sm font-semibold text-text-primary line-clamp-2">{c.title}</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <span className="rounded bg-primary-light px-1.5 py-0.5 text-[11px] font-medium text-primary">{c.product}</span>
        <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[11px] text-text-secondary">{c.releaseType}</span>
      </div>
      {c.cutover && c.cutover.total > 0 && (
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-100" title={`Cutover ${c.cutover.completed}/${c.cutover.total}`}>
          <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-text-secondary">
        <span>Go-live {fmtDate(c.plannedGoLive)}</span>
        <Avatar name={c.assignee.name} small />
      </div>
      {c.hasConflict && <p className="mt-2 text-xs font-semibold text-rose-600">⚠ Same-day {c.product} go-live</p>}
    </Link>
  );
}
