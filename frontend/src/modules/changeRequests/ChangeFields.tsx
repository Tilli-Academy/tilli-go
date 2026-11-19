import type { ChangeDetail, Lists, ListValue, Person } from './types';
import { inputCls, labelCls } from './ui';

// The change-request fields, shared by "New change request" and "Edit".
// Dropdown values come from the managed lists (Admin → Lists).

export interface CrForm {
  title: string;
  description: string;
  changeTypeId: string;
  releaseTypeId: string;
  priorityId: string;
  teamId: string;
  productIds: string[];
  risk: string;
  impact: string;
  customer: string;
  labels: string;
  plannedGoLive: string;
  dueDate: string;
  datePresented: string;
  codeFreezeDate: string;
  downtimeHours: string;
  needsCutover: boolean;
  assigneeId: string;
}

export const emptyForm = (): CrForm => ({
  title: '', description: '', changeTypeId: '', releaseTypeId: '', priorityId: '', teamId: '', productIds: [],
  risk: 'LOW', impact: '', customer: '', labels: '', plannedGoLive: '', dueDate: '', datePresented: '', codeFreezeDate: '',
  downtimeHours: '', needsCutover: true, assigneeId: '',
});

const day = (s: string | null) => (s ? s.slice(0, 10) : '');

export const formFrom = (cr: ChangeDetail): CrForm => ({
  title: cr.title,
  description: cr.description,
  changeTypeId: cr.changeType?.id ?? '',
  releaseTypeId: cr.releaseType?.id ?? '',
  priorityId: cr.priority?.id ?? '',
  teamId: cr.team?.id ?? '',
  productIds: cr.products.map((p) => p.id),
  risk: cr.risk,
  impact: cr.impact ?? '',
  customer: cr.customer ?? '',
  labels: cr.labels.join(', '),
  plannedGoLive: day(cr.plannedGoLive),
  dueDate: day(cr.dueDate),
  datePresented: day(cr.datePresented),
  codeFreezeDate: day(cr.codeFreezeDate),
  downtimeHours: cr.downtimeHours === null ? '' : String(cr.downtimeHours),
  needsCutover: cr.needsCutover,
  assigneeId: cr.assignee.id,
});

/** Request body: empty optional fields become null. */
export function payload(f: CrForm) {
  const orNull = (s: string) => (s.trim() ? s.trim() : null);
  return {
    title: f.title,
    description: f.description,
    changeTypeId: f.changeTypeId || undefined,
    releaseTypeId: f.releaseTypeId || undefined,
    priorityId: f.priorityId || undefined,
    teamId: f.teamId || null,
    productIds: f.productIds,
    risk: f.risk,
    impact: f.impact || null,
    customer: orNull(f.customer),
    labels: f.labels.split(',').map((s) => s.trim()).filter(Boolean),
    plannedGoLive: f.plannedGoLive || undefined,
    dueDate: f.dueDate || null,
    datePresented: f.datePresented || null,
    codeFreezeDate: f.codeFreezeDate || null,
    downtimeHours: f.downtimeHours.trim() === '' ? null : Number(f.downtimeHours),
    needsCutover: f.needsCutover,
    assigneeId: f.assigneeId,
  };
}

/** Active values, plus the one already chosen even if it was deactivated since. */
const options = (values: ListValue[], keep: string[]) => values.filter((v) => v.active || keep.includes(v.id));

function Pick({ id, label, value, values, onChange, optional, err }: {
  id: string; label: string; value: string; values: ListValue[]; onChange: (v: string) => void; optional?: boolean; err?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}{optional && ' (optional)'}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        <option value="">{optional ? 'None' : 'Choose…'}</option>
        {options(values, [value]).map((v) => <option key={v.id} value={v.id}>{v.label}{v.active ? '' : ' (no longer offered)'}</option>)}
      </select>
      {err && <p className="mt-1 text-xs font-medium text-destructive">{err}</p>}
    </div>
  );
}

function Levels({ label, value, risk, onChange, optional }: { label: string; value: string; risk: ListValue[]; onChange: (v: string) => void; optional?: boolean }) {
  const opts = [...(optional ? [{ key: '', label: '—', color: null }] : []), ...risk.map((r) => ({ key: r.key ?? '', label: r.label, color: r.color }))];
  return (
    <div>
      <span className={labelCls}>{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-border-strong bg-surface p-0.5">
        {opts.map((o) => (
          <button key={o.key || 'none'} type="button" role="radio" aria-checked={value === o.key} onClick={() => onChange(o.key)}
            style={value === o.key && o.color ? { background: o.color } : undefined}
            className={`rounded-md px-3 py-1.5 text-sm transition ${value === o.key ? 'bg-primary font-semibold text-white' : 'text-text-secondary hover:bg-surface-hover'}`}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

export default function ChangeFields({ f, set, lists, users, errors, goLiveLocked }: {
  f: CrForm;
  set: <K extends keyof CrForm>(k: K, v: CrForm[K]) => void;
  lists: Lists;
  users: Person[];
  errors: Record<string, string>;
  /** After approval the go-live date only changes by sending the CR back. */
  goLiveLocked?: boolean;
}) {
  const Err = ({ k }: { k: string }) => (errors[k] ? <p className="mt-1 text-xs font-medium text-destructive">{errors[k]}</p> : null);
  const products = options(lists.product, f.productIds);
  const toggle = (id: string) => set('productIds', f.productIds.includes(id) ? f.productIds.filter((x) => x !== id) : [...f.productIds, id]);

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="cr-title" className={labelCls}>Title</label>
        <input id="cr-title" value={f.title} onChange={(e) => set('title', e.target.value)} className={inputCls} />
        <Err k="title" />
      </div>
      <div>
        <label htmlFor="cr-desc" className={labelCls}>Description</label>
        <textarea id="cr-desc" rows={4} value={f.description} onChange={(e) => set('description', e.target.value)} className={inputCls} placeholder="What changes, why, and how it is tested" />
        <Err k="description" />
      </div>

      <div>
        <span className={labelCls}>Products</span>
        <div role="group" aria-label="Products" className="flex flex-wrap gap-2">
          {products.map((p) => {
            const on = f.productIds.includes(p.id);
            return (
              <button key={p.id} type="button" aria-pressed={on} onClick={() => toggle(p.id)}
                className={`rounded-full border px-3 py-1 text-sm transition ${on ? 'border-primary bg-primary-light font-semibold text-primary' : 'border-border-strong text-text-secondary hover:bg-surface-hover'}`}>
                {on ? '✓ ' : ''}{p.label}
              </button>
            );
          })}
          {products.length === 0 && <span className="text-sm text-text-muted">No products yet - an admin adds them under Admin → Lists.</span>}
        </div>
        <Err k="productIds" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Pick id="cr-ctype" label="Change type" value={f.changeTypeId} values={lists.change_type} onChange={(v) => set('changeTypeId', v)} err={errors.changeTypeId} />
        <Pick id="cr-rtype" label="Release type" value={f.releaseTypeId} values={lists.release_type} onChange={(v) => set('releaseTypeId', v)} err={errors.releaseTypeId} />
        <Pick id="cr-team" label="Team" value={f.teamId} values={lists.team} onChange={(v) => set('teamId', v)} optional />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Pick id="cr-priority" label="Priority" value={f.priorityId} values={lists.priority} onChange={(v) => set('priorityId', v)} err={errors.priorityId} />
        <Levels label="Risk" value={f.risk} risk={lists.risk} onChange={(v) => set('risk', v)} />
        <Levels label="Impact" value={f.impact} risk={lists.risk} onChange={(v) => set('impact', v)} optional />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="cr-golive" className={labelCls}>Deployment date</label>
          <input id="cr-golive" type="date" value={f.plannedGoLive} disabled={goLiveLocked} title={goLiveLocked ? 'Locked once approved' : undefined}
            onChange={(e) => set('plannedGoLive', e.target.value)} className={inputCls} />
          <Err k="plannedGoLive" />
        </div>
        <div>
          <label htmlFor="cr-freeze" className={labelCls}>Code freeze (optional)</label>
          <input id="cr-freeze" type="date" value={f.codeFreezeDate} onChange={(e) => set('codeFreezeDate', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="cr-presented" className={labelCls} title="The CAB meeting it is presented at">Date presented (optional)</label>
          <input id="cr-presented" type="date" value={f.datePresented} onChange={(e) => set('datePresented', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="cr-downtime" className={labelCls}>Downtime, hours (optional)</label>
          <input id="cr-downtime" type="number" min={0} max={1000} step={0.25} inputMode="decimal" value={f.downtimeHours}
            onChange={(e) => set('downtimeHours', e.target.value)} className={inputCls} />
          <Err k="downtimeHours" />
        </div>
        <div>
          <label htmlFor="cr-due" className={labelCls}>Due date (optional)</label>
          <input id="cr-due" type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label htmlFor="cr-assignee" className={labelCls}>Assignee</label>
          <select id="cr-assignee" value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)} className={inputCls}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <Err k="assigneeId" />
        </div>
        <div>
          <label htmlFor="cr-customer" className={labelCls}>Customer (optional)</label>
          <input id="cr-customer" value={f.customer} onChange={(e) => set('customer', e.target.value)} className={inputCls} placeholder="Empty = internal" />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="cr-labels" className={labelCls}>Labels (comma separated)</label>
          <input id="cr-labels" value={f.labels} onChange={(e) => set('labels', e.target.value)} className={inputCls} placeholder="api, onboarding" />
        </div>
      </div>

      <label className="flex items-center gap-3">
        <input type="checkbox" checked={f.needsCutover} onChange={(e) => set('needsCutover', e.target.checked)} />
        <span className="text-sm font-medium text-text-primary" title="The go-live tasks of the change's project">Needs a cutover plan</span>
      </label>
    </div>
  );
}
