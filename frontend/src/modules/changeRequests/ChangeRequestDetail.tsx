import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getErrorMessage } from '../../services/api';
import { toast } from '../../components/ui/Toast';
import { crApi } from './api';
import ProjectCard from './ProjectCard';
import type { ChangeDetail, Transition } from './types';
import { Avatar, Level, PriorityTag, STATUS_FLOW, STATUS_META, StatusPill, btnGhost, btnPrimary, card, crNo, fmtDate, fmtDateTime, inputCls, relDays } from './ui';

export default function ChangeRequestDetail() {
  const { id = '' } = useParams();
  const [cr, setCr] = useState<ChangeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Transition | null>(null);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    crApi.get(id).then((r) => { setCr(r.data); setError(null); }).catch((e) => setError(getErrorMessage(e)));
  }, [id]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok, 'success'); load(); return true; }
    catch (e) { toast(getErrorMessage(e)); return false; }
    finally { setBusy(false); }
  };

  const move = async (t: Transition) => {
    if (await run(() => crApi.transition(id, t.to, t.needsReason ? reason : undefined), `Moved to ${STATUS_META[t.to].label}`)) {
      setPicked(null); setReason('');
    }
  };

  if (error) return <div className="p-6"><p className="text-sm text-destructive bg-destructive-light p-3 rounded">{error}</p><Link to="/change-requests" className="text-sm text-primary">← Back</Link></div>;
  if (!cr) return <div className="p-6 text-sm text-text-muted">Loading…</div>;

  const idx = STATUS_FLOW.indexOf(cr.status);
  const cancelled = cr.status === 'CANCELLED';
  const backMoves = cr.events.filter((e) => e.kind === 'STATUS' && e.fromStatus && e.toStatus && e.toStatus !== 'CANCELLED' && STATUS_FLOW.indexOf(e.toStatus) < STATUS_FLOW.indexOf(e.fromStatus)).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-[1200px] mx-auto space-y-5">
        <div>
          <Link to="/change-requests" className="text-sm text-primary hover:underline">← All change requests</Link>
          <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-sm text-text-muted">{crNo(cr.number)} · {cr.product} · {cr.releaseType}</p>
              <h2 className="text-xl sm:text-2xl font-semibold text-text-primary">{cr.title}</h2>
            </div>
            <div className="flex items-center gap-2"><PriorityTag priority={cr.priority} /><StatusPill status={cr.status} /></div>
          </div>
        </div>

        {/* Life-cycle stepper + actions */}
        <section className={`${card} p-5`}>
          <ol className="flex items-start overflow-x-auto pb-1" aria-label="Life cycle">
            {STATUS_FLOW.map((s, i) => {
              const done = !cancelled && i < idx;
              const current = !cancelled && i === idx;
              return (
                <li key={s} className="flex flex-1 items-start last:flex-none" aria-current={current ? 'step' : undefined}>
                  <div className="flex w-24 flex-col items-center text-center">
                    <span className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ring-4 ${done ? 'bg-primary text-white ring-primary-light' : current ? 'bg-surface text-primary ring-primary' : 'bg-slate-100 text-text-muted ring-slate-50'}`}>{done ? '✓' : i + 1}</span>
                    <span className={`mt-2 text-xs font-semibold ${current ? 'text-primary' : done ? 'text-text-primary' : 'text-text-muted'}`}>{STATUS_META[s].label}</span>
                    {current && <span className="text-[11px] leading-tight text-text-secondary">{STATUS_META[s].hint}</span>}
                  </div>
                  {i < STATUS_FLOW.length - 1 && <span className={`mt-4 h-1 min-w-[12px] flex-1 rounded ${done ? 'bg-primary' : 'bg-slate-200'}`} />}
                </li>
              );
            })}
          </ol>
          {cancelled && <p className="mt-3 rounded bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">This change request was cancelled.</p>}
          {backMoves > 0 && <p className="mt-3 text-xs text-amber-700">↩ Moved back {backMoves} time{backMoves > 1 ? 's' : ''} - reasons are in the history below.</p>}

          <div className="mt-4 border-t border-border pt-4 space-y-3">
            {cr.transitions.length === 0 ? (
              <p className="text-sm text-text-secondary">This change request is finished - no further moves.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {cr.transitions.map((t) => {
                  const locked = !!t.approverOnly && !cr.canApprove;
                  const cls = t.kind === 'forward' ? btnPrimary : t.kind === 'cancel' ? `${btnGhost} !text-rose-600` : btnGhost;
                  return (
                    <button key={t.to} type="button" disabled={busy || locked} className={cls}
                      title={locked ? 'Approvers only' : undefined}
                      onClick={() => (t.needsReason ? setPicked(picked?.to === t.to ? null : t) : move(t))}>
                      {locked ? '🔒 ' : t.kind === 'back' ? '↩ ' : ''}{t.label}
                    </button>
                  );
                })}
              </div>
            )}
            {cr.transitions.some((t) => t.approverOnly) && !cr.canApprove && (
              <p className="text-xs text-text-secondary">🔒 Waiting for an approver.</p>
            )}
            {picked && (
              <form onSubmit={(e) => { e.preventDefault(); move(picked); }} className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <label htmlFor="cr-reason" className="text-sm font-semibold text-amber-900">Why? <span className="font-normal">(saved in the history)</span></label>
                <textarea id="cr-reason" rows={2} required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder="e.g. Regression found in UAT - login fails on Android" autoFocus />
                <div className="flex gap-2">
                  <button type="submit" disabled={busy} className={btnPrimary}>{picked.label}</button>
                  <button type="button" className={btnGhost} onClick={() => setPicked(null)}>Never mind</button>
                </div>
              </form>
            )}
          </div>
        </section>

        {cr.conflicts.length > 0 && (
          <div className="flex gap-3 rounded-card border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">
            <span aria-hidden="true">⚠</span>
            <div>
              <p className="font-semibold">Date conflict: another {cr.product} change goes live on {fmtDate(cr.plannedGoLive)}</p>
              {cr.conflicts.map((x) => <Link key={x.id} to={`/change-requests/${x.id}`} className="block hover:underline">{crNo(x.number)} · {x.title} ({x.assignee.name})</Link>)}
            </div>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2 min-w-0">
            <ProjectCard cr={cr} onChanged={load} />

            <section className={`${card} p-5`}>
              <h3 className="mb-2 font-semibold text-text-primary">Description</h3>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">{cr.description}</p>
            </section>

            <section className={`${card} p-5`}>
              <h3 className="mb-3 font-semibold text-text-primary">Attachments <span className="text-xs font-normal text-text-muted">screenshots, test evidence</span></h3>
              <ul className="mb-3 space-y-2">
                {cr.attachments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                    <button type="button" onClick={() => crApi.openAttachment(cr.id, a.id, a.fileName).catch((e) => toast(getErrorMessage(e)))} className="truncate text-left font-medium text-primary hover:underline">{a.fileName}</button>
                    <span className="flex-shrink-0 text-xs text-text-muted">{Math.max(1, Math.round(a.size / 1024))} KB · {fmtDateTime(a.createdAt)}</span>
                  </li>
                ))}
                {cr.attachments.length === 0 && <li className="text-sm text-text-muted">No attachments yet.</li>}
              </ul>
              <input ref={fileRef} type="file" className="hidden" aria-label="Choose file"
                onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) await run(() => crApi.upload(cr.id, file), `Uploaded ${file.name}`); }} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className={btnGhost}>📎 Upload file</button>
            </section>

            <section className={`${card} p-5`}>
              <h3 className="mb-4 font-semibold text-text-primary">Activity & comments</h3>
              <form onSubmit={async (e: React.FormEvent) => { e.preventDefault(); if (comment.trim() && (await run(() => crApi.comment(cr.id, comment.trim())))) setComment(''); }} className="mb-5 space-y-2">
                <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} placeholder="Add a comment, test result, or question…" aria-label="Comment" />
                <button type="submit" disabled={busy || !comment.trim()} className={btnPrimary}>Comment</button>
              </form>
              <ol className="relative space-y-4 border-l-2 border-border pl-5">
                {cr.events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className={`absolute -left-[27px] top-1.5 h-3 w-3 rounded-full ring-4 ring-white ${e.kind === 'STATUS' ? 'bg-primary' : e.kind === 'COMMENT' ? 'bg-slate-400' : e.kind === 'CUTOVER' ? 'bg-emerald-500' : 'bg-violet-400'}`} />
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-text-secondary">
                      <b className="text-text-primary">{e.actor.name}</b>
                      {e.kind === 'STATUS' && e.fromStatus && e.toStatus ? (<>moved <StatusPill status={e.fromStatus} /> → <StatusPill status={e.toStatus} /></>) : e.kind === 'COMMENT' ? 'commented' : e.message}
                      <span className="text-xs text-text-muted">{fmtDateTime(e.createdAt)}</span>
                    </div>
                    {(e.kind === 'COMMENT' || (e.kind === 'STATUS' && e.message)) && (
                      <p className={`mt-1 whitespace-pre-wrap rounded-md px-3 py-2 text-sm ${e.kind === 'COMMENT' ? 'bg-surface-hover text-text-primary' : 'bg-amber-50 text-amber-900'}`}>{e.message}</p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <aside className="space-y-5 min-w-0">
            <section className={`${card} p-5 space-y-3 text-sm`}>
              <h3 className="font-semibold text-text-primary">Details</h3>
              {([
                ['Change type', cr.changeType],
                ['Release type', cr.releaseType],
                ['Customer', cr.customer ?? 'Internal'],
                ['Planned go-live', `${fmtDate(cr.plannedGoLive)} (${relDays(cr.plannedGoLive)})`],
                ['Due date', fmtDate(cr.dueDate)],
                ['Project', cr.project ? cr.project.code : 'None yet'],
                ['Cutover', cr.needsCutover ? 'Needed' : 'Not needed'],
              ] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><span className="text-text-secondary">{k}</span><span className="text-right font-medium text-text-primary">{v}</span></div>
              ))}
              <div className="flex gap-4 border-t border-border pt-3"><Level label="Impact" value={cr.impact} /><Level label="Risk" value={cr.risk} /></div>
              {cr.labels.length > 0 && <div className="flex flex-wrap gap-1.5">{cr.labels.map((l) => <span key={l} className="rounded-full bg-surface-hover px-2 py-0.5 text-xs text-text-secondary">#{l}</span>)}</div>}
            </section>
            <section className={`${card} p-5 space-y-3 text-sm`}>
              <h3 className="font-semibold text-text-primary">People</h3>
              {([['Assignee', cr.assignee], ['Reporter', cr.reporter], ['Approved by', cr.approvedBy]] as const).map(([k, u]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span className="text-text-secondary">{k}</span>
                  {u ? <span className="flex items-center gap-2 font-medium text-text-primary"><Avatar name={u.name} small />{u.name}</span> : <span className="text-text-muted">Not yet</span>}
                </div>
              ))}
              {cr.approvedAt && <p className="text-xs text-text-muted">Approved {fmtDateTime(cr.approvedAt)}</p>}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
