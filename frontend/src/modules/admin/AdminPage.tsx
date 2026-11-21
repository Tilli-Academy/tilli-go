import { useState } from 'react';
import api, { getErrorMessage } from '../../services/api';
import { toast } from '../../components/ui/Toast';
import { invalidateLists, useLists } from '../../hooks/useLists';
import { usePermissions } from '../../hooks/usePermissions';
import type { ListName, ListValue } from '../changeRequests/types';
import { btnGhost, btnPrimary, card, inputCls } from '../changeRequests/ui';

// Admin → Lists: the dropdown values used across change requests.
// Values are rows with stable ids: rename, recolour, reorder or deactivate them
// without touching the CRs that use them. Values in use can't be deleted.

const LISTS: { name: ListName; label: string; fixed?: boolean }[] = [
  { name: 'change_type', label: 'Change type' },
  { name: 'release_type', label: 'Release type' },
  { name: 'product', label: 'Products' },
  { name: 'priority', label: 'Priority' },
  { name: 'team', label: 'Team' },
  { name: 'supporting_document', label: 'Supporting documents' },
  { name: 'risk', label: 'Risk', fixed: true },
  { name: 'decision', label: 'Decision', fixed: true },
];

export default function AdminPage() {
  const { loaded, can } = usePermissions();
  const { lists, reload } = useLists(true);
  const [current, setCurrent] = useState<ListName>('change_type');
  const [busy, setBusy] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('');
  const [newRequired, setNewRequired] = useState(false);

  const switchTo = (name: ListName) => { setCurrent(name); setNewLabel(''); setNewColor(''); setNewRequired(false); };

  if (loaded && !can('admin.lists')) {
    return <div className="p-6"><p className="text-sm text-text-secondary">You don't have access to the admin pages.</p></div>;
  }
  const meta = LISTS.find((l) => l.name === current)!;
  const values = lists?.[current] ?? [];

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      invalidateLists();
      reload();
      if (ok) toast(ok, 'success');
      return true;
    } catch (e) {
      toast(getErrorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const patch = (v: ListValue, body: Partial<Pick<ListValue, 'label' | 'color' | 'active' | 'required'>>) =>
    run(() => api.patch(`/lists/values/${v.id}`, body));
  const move = (i: number, by: number) => {
    const ids = values.map((v) => v.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void run(() => api.put(`/lists/${current}/order`, { ids }));
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold text-text-primary">Admin</h2>
          <nav aria-label="Admin sections" className="inline-flex rounded-lg border border-border-strong bg-surface p-0.5 text-sm">
            <span aria-current="page" className="rounded-md bg-primary px-3 py-1.5 font-semibold text-white">Lists</span>
          </nav>
        </div>

        <div className="grid gap-5 md:grid-cols-[220px_1fr]">
          <div>
            <label htmlFor="admin-list" className="sr-only">List</label>
            <select id="admin-list" value={current} onChange={(e) => switchTo(e.target.value as ListName)} className={`${inputCls} md:hidden`}>
              {LISTS.map((l) => <option key={l.name} value={l.name}>{l.label}</option>)}
            </select>
            <ul className="hidden md:block space-y-1" role="tablist" aria-label="Lists">
              {LISTS.map((l) => (
                <li key={l.name}>
                  <button type="button" role="tab" aria-selected={current === l.name} onClick={() => switchTo(l.name)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${current === l.name ? 'bg-primary-light font-semibold text-primary' : 'text-text-secondary hover:bg-surface-hover'}`}>
                    {l.label}
                    <span className="text-xs text-text-muted">{lists?.[l.name]?.filter((v) => v.active).length ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <section className={`${card} min-w-0`} aria-labelledby="admin-list-h">
            <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
              <h3 id="admin-list-h" className="font-semibold text-text-primary">{meta.label}</h3>
              {meta.fixed && <span className="text-xs text-text-secondary" title="These keys drive rules">Labels and colours only</span>}
            </div>
            {!lists && <p className="p-4 text-sm text-text-muted">Loading…</p>}
            <ul className="divide-y divide-border">
              {values.map((v, i) => (
                <li key={v.id} className={`flex flex-wrap items-center gap-2 px-4 py-2 ${v.active ? '' : 'bg-surface-hover/60'}`}>
                  <span className="flex flex-col">
                    <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${v.label} up`} className="px-1 text-xs text-text-secondary disabled:opacity-30">▲</button>
                    <button type="button" disabled={busy || i === values.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${v.label} down`} className="px-1 text-xs text-text-secondary disabled:opacity-30">▼</button>
                  </span>
                  <input type="color" aria-label={`${v.label} colour`} value={v.color ?? '#94a3b8'} disabled={busy}
                    onChange={(e) => void patch(v, { color: e.target.value })} className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0.5" />
                  <input aria-label={`${v.label} label`} defaultValue={v.label} key={`${v.id}-${v.label}`} maxLength={60}
                    onBlur={(e) => { const label = e.target.value.trim(); if (label && label !== v.label) void patch(v, { label }); else e.target.value = v.label; }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    className={`${inputCls} min-w-[160px] flex-1 ${v.active ? '' : 'text-text-muted'}`} />
                  {current === 'supporting_document' && (
                    <label className="flex items-center gap-1.5 text-xs text-text-secondary" title="Must be attached before a change can be approved">
                      <input type="checkbox" checked={!!v.required} disabled={busy} onChange={(e) => void patch(v, { required: e.target.checked })} />Required
                    </label>
                  )}
                  <span className="w-20 text-right text-xs text-text-muted">{v.inUse ? `${v.inUse} in use` : 'unused'}</span>
                  {!meta.fixed && (
                    <button type="button" disabled={busy} onClick={() => void patch(v, { active: !v.active })} className="text-xs font-medium text-text-secondary hover:text-primary">
                      {v.active ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                  {!meta.fixed && !v.inUse && (
                    <button type="button" disabled={busy} onClick={() => void run(() => api.delete(`/lists/values/${v.id}`), `Removed ${v.label}`)} className="text-xs font-medium text-rose-600 hover:underline">
                      Delete
                    </button>
                  )}
                </li>
              ))}
              {lists && values.length === 0 && <li className="px-4 py-6 text-center text-sm text-text-muted">No values yet.</li>}
            </ul>
            {!meta.fixed && (
              <form className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ok = await run(() => api.post(`/lists/${current}`, { label: newLabel.trim(), color: newColor || null, ...(current === 'supporting_document' ? { required: newRequired } : {}) }), `Added ${newLabel.trim()}`);
                  if (ok) { setNewLabel(''); setNewColor(''); setNewRequired(false); }
                }}>
                <input type="color" aria-label="New value colour" value={newColor || '#94a3b8'} onChange={(e) => setNewColor(e.target.value)} className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0.5" />
                <input aria-label="New value" placeholder="New value" value={newLabel} maxLength={60} onChange={(e) => setNewLabel(e.target.value)} className={`${inputCls} min-w-[160px] flex-1`} />
                {current === 'supporting_document' && (
                  <label className="flex items-center gap-1.5 text-xs text-text-secondary"><input type="checkbox" checked={newRequired} onChange={(e) => setNewRequired(e.target.checked)} />Required</label>
                )}
                <button type="submit" disabled={busy || !newLabel.trim()} className={btnPrimary}>Add</button>
                {newColor && <button type="button" onClick={() => setNewColor('')} className={btnGhost}>No colour</button>}
              </form>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
