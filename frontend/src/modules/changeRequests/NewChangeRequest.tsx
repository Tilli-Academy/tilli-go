import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { getErrorMessage } from '../../services/api';
import { toast } from '../../components/ui/Toast';
import { crApi } from './api';
import type { Conflict, CrMeta } from './types';
import { btnGhost, btnPrimary, card, crNo, inputCls, labelCls } from './ui';

function Segmented({ value, options, onChange, label }: { value: string; options: string[]; onChange: (v: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-border-strong bg-surface p-0.5">
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)}
          className={`rounded-md px-3 py-1.5 text-sm transition ${value === o ? 'bg-primary font-semibold text-white' : 'text-text-secondary hover:bg-surface-hover'}`}>{o}</button>
      ))}
    </div>
  );
}

function currentUserId(): string | null {
  try { return (JSON.parse(localStorage.getItem('user') || 'null') as { id?: string } | null)?.id ?? null; } catch { return null; }
}

export default function NewChangeRequest() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState<CrMeta | null>(null);
  const [f, setF] = useState({
    title: '', description: '', product: 'Nudge', changeType: 'Normal', releaseType: 'Minor release',
    priority: 'Medium', impact: 'Medium', risk: 'Low', customer: '', labels: '', plannedGoLive: '', dueDate: '',
    assigneeId: '', reporterId: '', needsCutover: true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    crApi.meta().then((r) => {
      setMeta(r.data);
      const approver = r.data.users.find((u) => r.data.approverRoles.includes(u.role));
      setF((p) => ({ ...p, assigneeId: currentUserId() ?? r.data.users[0]?.id ?? '', reporterId: approver?.id ?? r.data.users[0]?.id ?? '' }));
    }).catch((e) => toast(getErrorMessage(e)));
  }, []);

  useEffect(() => {
    if (!f.plannedGoLive) { setConflicts([]); return; }
    let live = true;
    crApi.conflicts(f.product, f.plannedGoLive).then((r) => live && setConflicts(r.data.conflicts)).catch(() => {});
    return () => { live = false; };
  }, [f.product, f.plannedGoLive]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const res = await crApi.create({
        ...f,
        customer: f.customer || undefined,
        dueDate: f.dueDate || undefined,
        labels: f.labels.split(',').map((s) => s.trim()).filter(Boolean),
      });
      toast(`${crNo(res.data.number)} created`, 'success');
      navigate(`/change-requests/${res.data.id}`);
    } catch (err) {
      if (axios.isAxiosError<{ details?: { field: string; message: string }[] }>(err) && err.response?.data?.details) {
        setErrors(Object.fromEntries(err.response.data.details.map((d) => [d.field, d.message])));
        toast('Please fix the highlighted fields');
      } else toast(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const Err = ({ k }: { k: string }) => (errors[k] ? <p className="mt-1 text-xs font-medium text-destructive">{errors[k]}</p> : null);
  const o = meta?.options;

  return (
    <div className="flex-1 overflow-y-auto">
      <form onSubmit={submit} className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
        <div>
          <Link to="/change-requests" className="text-sm text-primary hover:underline">← All change requests</Link>
          <h2 className="mt-1 text-xl font-semibold text-text-primary">New Change Request</h2>
          <p className="text-sm text-text-secondary">Every change to production starts here, so it can be tracked from development to go-live.</p>
        </div>

        <section className={`${card} p-5 space-y-4`}>
          <h3 className="font-semibold text-text-primary">1 · What is changing?</h3>
          <div>
            <label htmlFor="cr-title" className={labelCls}>Title</label>
            <input id="cr-title" value={f.title} onChange={(e) => set('title')(e.target.value)} className={inputCls} placeholder="e.g. Nudge - add WhatsApp channel for customer X" />
            <Err k="title" />
          </div>
          <div>
            <label htmlFor="cr-desc" className={labelCls}>Description</label>
            <textarea id="cr-desc" rows={4} value={f.description} onChange={(e) => set('description')(e.target.value)} className={inputCls} placeholder="What changes, why, and how it will be tested" />
            <Err k="description" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div><label htmlFor="cr-product" className={labelCls}>Product</label>
              <select id="cr-product" value={f.product} onChange={(e) => set('product')(e.target.value)} className={inputCls}>{o?.products.map((p) => <option key={p}>{p}</option>)}</select></div>
            <div><label htmlFor="cr-ctype" className={labelCls}>Change type</label>
              <select id="cr-ctype" value={f.changeType} onChange={(e) => set('changeType')(e.target.value)} className={inputCls}>{o?.changeTypes.map((p) => <option key={p}>{p}</option>)}</select></div>
            <div><label htmlFor="cr-rtype" className={labelCls}>Release type</label>
              <select id="cr-rtype" value={f.releaseType} onChange={(e) => set('releaseType')(e.target.value)} className={inputCls}>{o?.releaseTypes.map((p) => <option key={p}>{p}</option>)}</select></div>
          </div>
        </section>

        <section className={`${card} p-5 space-y-4`}>
          <h3 className="font-semibold text-text-primary">2 · How risky is it?</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <div><span className={labelCls}>Priority</span><Segmented label="Priority" value={f.priority} options={o?.priorities ?? []} onChange={set('priority')} /></div>
            <div><span className={labelCls}>Impact</span><Segmented label="Impact" value={f.impact} options={o?.levels ?? []} onChange={set('impact')} /></div>
            <div><span className={labelCls}>Risk</span><Segmented label="Risk" value={f.risk} options={o?.levels ?? []} onChange={set('risk')} /></div>
          </div>
        </section>

        <section className={`${card} p-5 space-y-4`}>
          <h3 className="font-semibold text-text-primary">3 · Who and when?</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label htmlFor="cr-assignee" className={labelCls}>Assignee (developer / BA)</label>
              <select id="cr-assignee" value={f.assigneeId} onChange={(e) => set('assigneeId')(e.target.value)} className={inputCls}>{meta?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
              <Err k="assigneeId" /></div>
            <div><label htmlFor="cr-reporter" className={labelCls}>Reporter (manager)</label>
              <select id="cr-reporter" value={f.reporterId} onChange={(e) => set('reporterId')(e.target.value)} className={inputCls}>{meta?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
              <Err k="reporterId" /></div>
            <div><label htmlFor="cr-golive" className={labelCls}>Planned go-live date</label>
              <input id="cr-golive" type="date" value={f.plannedGoLive} onChange={(e) => set('plannedGoLive')(e.target.value)} className={inputCls} />
              <Err k="plannedGoLive" /></div>
            <div><label htmlFor="cr-due" className={labelCls}>Due date (optional)</label>
              <input id="cr-due" type="date" value={f.dueDate} onChange={(e) => set('dueDate')(e.target.value)} className={inputCls} /></div>
            <div><label htmlFor="cr-customer" className={labelCls}>Customer / project (optional)</label>
              <input id="cr-customer" value={f.customer} onChange={(e) => set('customer')(e.target.value)} className={inputCls} placeholder="Leave empty for internal changes" /></div>
            <div><label htmlFor="cr-labels" className={labelCls}>Labels (comma separated)</label>
              <input id="cr-labels" value={f.labels} onChange={(e) => set('labels')(e.target.value)} className={inputCls} placeholder="api, onboarding" /></div>
          </div>

          {conflicts.length > 0 && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
              <p className="font-semibold">⚠ {conflicts.length} other {f.product} change{conflicts.length > 1 ? 's' : ''} already planned for this day</p>
              <ul className="mt-2 space-y-1">{conflicts.map((c) => <li key={c.id}>{crNo(c.number)} · {c.title} <span className="text-rose-500">({c.assignee.name})</span></li>)}</ul>
              <p className="mt-2 text-xs">You can still submit - talk to the other owner or pick another date.</p>
            </div>
          )}
          {f.plannedGoLive && conflicts.length === 0 && <p className="text-sm font-medium text-emerald-700">✓ No other {f.product} go-live on this date.</p>}

          <label className="flex items-start gap-3 rounded-lg border border-border p-4">
            <input type="checkbox" checked={f.needsCutover} onChange={(e) => set('needsCutover')(e.target.checked)} className="mt-1" />
            <span>
              <span className="block text-sm font-semibold text-text-primary">This change needs a cutover plan</span>
              <span className="text-xs text-text-secondary">A Tilli-go project with step-by-step go-live tasks, owners and email reminders.</span>
            </span>
          </label>
        </section>

        <div className="flex justify-end gap-2 pb-6">
          <Link to="/change-requests" className={btnGhost}>Cancel</Link>
          <button type="submit" disabled={saving || !meta} className={btnPrimary}>{saving ? 'Creating…' : 'Create change request'}</button>
        </div>
      </form>
    </div>
  );
}
