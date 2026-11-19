import React, { useContext, useEffect, useState } from 'react';
import { ProjectContext } from '../../App';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { getErrorMessage } from '../../services/api';
import { toast } from '../../components/ui/Toast';
import { useLists } from '../../hooks/useLists';
import { crApi } from './api';
import type { Conflict, CrMeta } from './types';
import ChangeFields, { emptyForm, payload, type CrForm } from './ChangeFields';
import { btnGhost, btnPrimary, card, crNo, inputCls, labelCls } from './ui';

function currentUserId(): string | null {
  try { return (JSON.parse(localStorage.getItem('user') || 'null') as { id?: string } | null)?.id ?? null; } catch { return null; }
}

export default function NewChangeRequest() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState<CrMeta | null>(null);
  const { lists } = useLists();
  const { projects } = useContext(ProjectContext);
  const [f, setF] = useState<CrForm>(emptyForm);
  const [reporterId, setReporterId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof CrForm>(k: K, v: CrForm[K]) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    crApi.meta().then((r) => {
      setMeta(r.data);
      const approver = r.data.users.find((u) => r.data.approverRoles.includes(u.role));
      setF((p) => ({ ...p, assigneeId: currentUserId() ?? r.data.users[0]?.id ?? '' }));
      setReporterId(approver?.id ?? r.data.users[0]?.id ?? '');
    }).catch((e) => toast(getErrorMessage(e)));
  }, []);

  // Sensible defaults from the lists: first active value of each required list.
  useEffect(() => {
    if (!lists) return;
    const first = (n: keyof typeof lists) => lists[n].find((v) => v.active)?.id ?? '';
    setF((p) => ({
      ...p,
      changeTypeId: p.changeTypeId || first('change_type'),
      releaseTypeId: p.releaseTypeId || first('release_type'),
      priorityId: p.priorityId || lists.priority.find((v) => v.label === 'Medium')?.id || first('priority'),
    }));
  }, [lists]);

  useEffect(() => {
    if (!f.plannedGoLive || f.productIds.length === 0) { setConflicts([]); return; }
    let live = true;
    crApi.conflicts(f.productIds, f.plannedGoLive).then((r) => live && setConflicts(r.data.conflicts)).catch(() => {});
    return () => { live = false; };
  }, [f.productIds, f.plannedGoLive]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const body = payload(f);
      const res = await crApi.create({
        ...body,
        // create: leave optional fields out instead of sending null
        ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)),
        reporterId,
        projectId: projectId || undefined,
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

  return (
    <div className="flex-1 overflow-y-auto">
      <form onSubmit={submit} className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
        <div>
          <Link to="/change-requests" className="text-sm text-primary hover:underline">← All change requests</Link>
          <h2 className="mt-1 text-xl font-semibold text-text-primary">New Change Request</h2>
        </div>

        <section className={`${card} p-5`}>
          {lists && meta ? (
            <ChangeFields f={f} set={set} lists={lists} users={meta.users} errors={errors} />
          ) : (
            <p className="text-sm text-text-muted">Loading…</p>
          )}

          {conflicts.length > 0 && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
              <p className="font-semibold">⚠ {conflicts.length} other change{conflicts.length > 1 ? 's' : ''} for the same product go{conflicts.length > 1 ? '' : 'es'} live that day</p>
              <ul className="mt-2 space-y-1">{conflicts.map((c) => <li key={c.id}>{crNo(c.number)} · {c.title} <span className="text-rose-500">({c.assignee.name})</span></li>)}</ul>
            </div>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cr-reporter" className={labelCls}>Reporter</label>
              <select id="cr-reporter" value={reporterId} onChange={(e) => setReporterId(e.target.value)} className={inputCls}>
                {meta?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="cr-project" className={labelCls}>Project</label>
              <select id="cr-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls}>
                <option value="">Choose later</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
              </select>
            </div>
          </div>
        </section>

        <div className="flex justify-end gap-2 pb-6">
          <Link to="/change-requests" className={btnGhost}>Cancel</Link>
          <button type="submit" disabled={saving || !meta || !lists} className={btnPrimary}>{saving ? 'Creating…' : 'Create change request'}</button>
        </div>
      </form>
    </div>
  );
}
