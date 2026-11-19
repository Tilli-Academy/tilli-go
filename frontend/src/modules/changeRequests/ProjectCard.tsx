import { useContext, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ProjectContext } from '../../App';
import { getErrorMessage } from '../../services/api';
import { toast } from '../../components/ui/Toast';
import { crApi } from './api';
import type { ChangeDetail } from './types';
import { StatusPill, btnGhost, btnPrimary, card, crNo, inputCls } from './ui';

// A project groups one or more change requests (e.g. a release) and owns the
// optional cutover: its task plan. The CR picks or creates its project here.

const LOCKED = ['IMPLEMENT', 'REVIEW', 'CLOSED', 'CANCELLED'];
const ZONES = ['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'UTC', 'Europe/London', 'Asia/Kolkata'];

export default function ProjectCard({ cr, onChanged }: { cr: ChangeDetail; onChanged: () => void }) {
  const navigate = useNavigate();
  const { projects, refreshProjects, setSelectedProjectId } = useContext(ProjectContext);
  const [mode, setMode] = useState<'view' | 'pick' | 'create'>('view');
  const [pick, setPick] = useState('');
  const [form, setForm] = useState({ name: '', code: '', timeZone: 'America/Chicago' });
  const [busy, setBusy] = useState(false);

  const canChange = !LOCKED.includes(cr.status) && cr.permissions.includes('cr.edit');
  const canCreate = cr.permissions.includes('project.manage');
  const project = cr.project;
  const others = project?.changeRequests?.filter((c) => c.id !== cr.id) ?? [];
  const pct = cr.cutover && cr.cutover.total ? Math.round((cr.cutover.completed / cr.cutover.total) * 100) : 0;

  const save = async (body: Parameters<typeof crApi.setProject>[1], ok: string) => {
    setBusy(true);
    try {
      await crApi.setProject(cr.id, body);
      await refreshProjects();
      toast(ok, 'success');
      setMode('view');
      onChanged();
    } catch (e) {
      toast(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const open = async (path: '/tasks' | '/timeline') => {
    if (!project) return;
    setSelectedProjectId(project.id);
    navigate(path);
  };

  if (!project && !canChange) return null;

  return (
    <section className={`${card} p-5`} aria-labelledby="cr-project-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 id="cr-project-h" className="font-semibold text-text-primary">Project</h3>
          {project && (
            <p className="truncate text-sm text-text-secondary">
              <span className="font-mono text-xs font-semibold text-primary">{project.code}</span> · {project.name}
            </p>
          )}
        </div>
        {project && mode === 'view' && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => open('/timeline')} className={btnGhost}>Timeline</button>
            <button type="button" onClick={() => open('/tasks')} className={btnGhost}>Open tasks →</button>
            {canChange && <button type="button" onClick={() => setMode('pick')} className={btnGhost}>Change</button>}
          </div>
        )}
      </div>

      {project && others.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-text-secondary">Also in this project</p>
          <ul className="mt-1 space-y-1">
            {others.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <Link to={`/change-requests/${c.id}`} className="font-mono text-xs text-primary hover:underline">{crNo(c.number)}</Link>
                <span className="truncate text-text-primary">{c.title}</span>
                <StatusPill status={c.status} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {project && cr.cutover && mode === 'view' && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-sm">
            <span className="font-medium text-text-primary" title="The project's task plan (shared by every change request in it)">Cutover</span>
            <span className="text-text-secondary">{cr.cutover.completed}/{cr.cutover.total} tasks · {pct}%</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
          {cr.cutover.blocked > 0 && <p className="mt-2 text-xs font-semibold text-rose-600">{cr.cutover.blocked} task(s) blocked</p>}
          {cr.cutover.total === 0 && cr.needsCutover && <p className="mt-2 text-xs text-text-secondary">No tasks yet.</p>}
        </div>
      )}

      {canChange && (mode !== 'view' || !project) && (
        <div className="mt-4 space-y-3">
          {mode !== 'create' ? (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (pick) void save({ projectId: pick }, 'Project linked'); }}>
              <div className="min-w-[220px] flex-1">
                <label htmlFor="cr-pick-project" className="mb-1 block text-xs font-medium text-text-secondary">Existing project</label>
                <select id="cr-pick-project" value={pick} onChange={(e) => setPick(e.target.value)} className={inputCls}>
                  <option value="">Choose…</option>
                  {projects.filter((p) => p.id !== project?.id).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                </select>
              </div>
              <button type="submit" disabled={busy || !pick} className={btnPrimary}>Link</button>
              {canCreate && <button type="button" onClick={() => setMode('create')} className={btnGhost}>+ New project</button>}
              {project && <button type="button" disabled={busy} onClick={() => void save({ projectId: null }, 'Removed from project')} className={`${btnGhost} !text-rose-600`}>Remove</button>}
              {project && <button type="button" onClick={() => setMode('view')} className={btnGhost}>Cancel</button>}
            </form>
          ) : (
            <form
              className="grid gap-2 sm:grid-cols-[1fr_140px_200px_auto]"
              onSubmit={(e) => { e.preventDefault(); void save({ create: { ...form, code: form.code.toUpperCase() } }, 'Project created'); }}
            >
              <input aria-label="Project name" required maxLength={100} placeholder="Name, e.g. December release" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
              <input aria-label="Project code" required maxLength={20} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" placeholder="Code, e.g. REL-DEC" value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })} className={`${inputCls} font-mono uppercase`} />
              <select aria-label="Timezone" value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} className={inputCls} title="Times in emails and on the Timeline use this zone">
                {ZONES.map((z) => <option key={z}>{z}</option>)}
              </select>
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className={btnPrimary}>Create</button>
                <button type="button" onClick={() => setMode(project ? 'pick' : 'view')} className={btnGhost}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
