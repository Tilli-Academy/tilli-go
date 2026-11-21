import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getErrorMessage } from '../../services/api';
import { toast } from '../../components/ui/Toast';
import { crApi } from './api';
import type { ChangeDetail, DecisionKey, Lists } from './types';
import { StatusPill, btnGhost, btnPrimary, card, crNo, inputCls } from './ui';

// CAB pieces of a change request: the decision, supporting documents, linked CRs.

const NEEDS_REASON: DecisionKey[] = ['REQUEST_INFO', 'REJECTED'];

/** Approver's decision while the CR is in Assess. */
export function DecisionPanel({ cr, lists, onDone }: { cr: ChangeDetail; lists: Lists; onDone: () => void }) {
  const [picked, setPicked] = useState<DecisionKey | null>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  if (cr.status !== 'ASSESS') return null;
  if (!cr.canDecide) return <p className="text-xs text-text-secondary">🔒 Waiting for the CAB decision.</p>;

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      await crApi.decide(cr.id, picked, reason, date);
      toast(lists.decision.find((d) => d.key === picked)?.label ?? 'Saved', 'success');
      setPicked(null); setReason(''); setDate('');
      onDone();
    } catch (e) {
      toast(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text-primary">CAB decision</span>
        {lists.decision.map((d) => (
          <button key={d.id} type="button" disabled={busy} aria-pressed={picked === d.key}
            onClick={() => setPicked(picked === d.key ? null : (d.key as DecisionKey))}
            style={picked === d.key && d.color
              ? { background: `color-mix(in srgb, ${d.color} 75%, black)`, borderColor: 'transparent', color: '#fff' }
              : d.color ? { color: `color-mix(in srgb, ${d.color} 60%, black)`, borderColor: `${d.color}66` } : undefined}
            className={`${btnGhost}`}>
            {d.label}
          </button>
        ))}
      </div>
      {picked && (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-2 rounded-lg border border-border bg-surface-hover/50 p-3">
          {NEEDS_REASON.includes(picked) && (
            <>
              <label htmlFor="cr-decision-reason" className="text-sm font-semibold text-text-primary">Reason</label>
              <textarea id="cr-decision-reason" rows={2} required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} autoFocus />
            </>
          )}
          {picked === 'DEFERRED' && (
            <>
              <label htmlFor="cr-decision-date" className="text-sm font-semibold text-text-primary">Next CAB date</label>
              <input id="cr-decision-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </>
          )}
          {picked === 'APPROVED' && <p className="text-sm text-text-secondary">Approve and schedule {crNo(cr.number)}?</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={btnPrimary}>Confirm</button>
            <button type="button" className={btnGhost} onClick={() => setPicked(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Supporting-documents checklist: each type links to an attachment of this CR or a URL. */
export function DocumentsCard({ cr, lists, canEdit, onChanged }: { cr: ChangeDetail; lists: Lists; canEdit: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [attachmentId, setAttachmentId] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const docs = new Map(cr.documents.map((d) => [d.documentTypeId, d]));
  const types = lists.supporting_document.filter((t) => t.active || docs.has(t.id));
  const done = types.filter((t) => docs.has(t.id)).length;

  const save = async (typeId: string, body?: { attachmentId: string } | { url: string }) => {
    setBusy(true);
    try {
      if (body) await crApi.setDocument(cr.id, typeId, body);
      else await crApi.removeDocument(cr.id, typeId);
      setOpen(null); setAttachmentId(''); setUrl('');
      onChanged();
    } catch (e) {
      toast(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${card} p-5`} aria-labelledby="cr-docs-h">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 id="cr-docs-h" className="font-semibold text-text-primary">Supporting documents</h3>
        <span className="text-xs text-text-secondary">{done}/{types.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {types.map((t) => {
          const d = docs.get(t.id);
          return (
            <li key={t.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className={d ? 'text-emerald-600' : 'text-text-muted'}>{d ? '✓' : '○'}</span>
                  <span className="font-medium text-text-primary">{t.label}</span>
                  {t.required && !d && <span className="rounded bg-rose-50 px-1.5 text-[11px] font-semibold text-rose-700" title="Needed before approval">Required</span>}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  {d?.attachment && (
                    <button type="button" onClick={() => crApi.openAttachment(cr.id, d.attachment!.id, d.attachment!.fileName).catch((e) => toast(getErrorMessage(e)))}
                      className="truncate text-primary hover:underline">{d.attachment.fileName}</button>
                  )}
                  {d?.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className="max-w-[220px] truncate text-primary hover:underline">{d.url}</a>}
                  {canEdit && (
                    <button type="button" className="text-xs text-text-secondary hover:text-primary" onClick={() => setOpen(open === t.id ? null : t.id)}>
                      {d ? 'Change' : 'Add'}
                    </button>
                  )}
                  {canEdit && d && <button type="button" disabled={busy} className="text-xs text-rose-600 hover:underline" onClick={() => void save(t.id)}>Remove</button>}
                </span>
              </div>
              {open === t.id && (
                <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                  onSubmit={(e) => { e.preventDefault(); void save(t.id, attachmentId ? { attachmentId } : { url }); }}>
                  <select aria-label={`${t.label}: attachment`} value={attachmentId} onChange={(e) => { setAttachmentId(e.target.value); setUrl(''); }} className={inputCls}>
                    <option value="">Pick an attachment…</option>
                    {cr.attachments.map((a) => <option key={a.id} value={a.id}>{a.fileName}</option>)}
                  </select>
                  <input aria-label={`${t.label}: link`} type="url" placeholder="…or paste a link" value={url} onChange={(e) => { setUrl(e.target.value); setAttachmentId(''); }} className={inputCls} />
                  <button type="submit" disabled={busy || (!attachmentId && !url)} className={btnPrimary}>Save</button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Change requests linked to this one (shown on both). */
export function LinkedCard({ cr, canEdit, onChanged }: { cr: ChangeDetail; canEdit: boolean; onChanged: () => void }) {
  const [num, setNum] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); setNum(''); onChanged(); } catch (e) { toast(getErrorMessage(e)); } finally { setBusy(false); }
  };
  if (!canEdit && cr.linked.length === 0) return null;
  return (
    <section className={`${card} p-5 text-sm`} aria-labelledby="cr-links-h">
      <h3 id="cr-links-h" className="mb-2 font-semibold text-text-primary">Linked change requests</h3>
      <ul className="space-y-1.5">
        {cr.linked.map((l) => (
          <li key={l.id} className="flex items-center gap-2">
            <Link to={`/change-requests/${l.id}`} className="font-mono text-xs text-primary hover:underline">{crNo(l.number)}</Link>
            <span className="min-w-0 flex-1 truncate">{l.title}</span>
            <StatusPill status={l.status} />
            {canEdit && <button type="button" disabled={busy} aria-label={`Unlink ${crNo(l.number)}`} onClick={() => void run(() => crApi.removeLink(cr.id, l.id))} className="text-xs text-text-secondary hover:text-rose-600">✕</button>}
          </li>
        ))}
        {cr.linked.length === 0 && <li className="text-text-muted">None</li>}
      </ul>
      {canEdit && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); const n = Number(num.replace(/\D/g, '')); if (n) void run(() => crApi.addLink(cr.id, n)); }}>
          <input aria-label="CR number to link" placeholder="CR number, e.g. 1004" value={num} onChange={(e) => setNum(e.target.value)} className={inputCls} />
          <button type="submit" disabled={busy || !num.trim()} className={btnGhost}>Link</button>
        </form>
      )}
    </section>
  );
}
