import { useContext, useState } from 'react';
import { ProjectContext } from '../../App';
import api, { getErrorMessage } from '../../services/api';

// "Import from Excel": upload a cutover sheet saved as CSV, get a new project plus
// a report of what Excel could not tell you (end before start, clashes, bad dates).

interface Report {
  project: { id: string; code: string; name: string };
  imported: number;
  skippedBlank: number;
  sections: { name: string; tasks: number }[];
  checkpoints: number;
  noEstimate: number;
  durationMismatches: number;
  problems: { row: number; ref: string; task: string; issue: string }[];
  clashes: number;
  shiftedByDays: number | null;
}

function tomorrowAt7pm(): string {
  const d = new Date(Date.now() + 86_400_000);
  d.setHours(19, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T19:00`;
}

const input = 'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-text-primary';

export default function ImportSheet() {
  const { refreshProjects, setSelectedProjectId } = useContext(ProjectContext);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [replan, setReplan] = useState(true);
  const [startAt, setStartAt] = useState(tomorrowAt7pm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const close = () => { setOpen(false); setReport(null); setError(null); setFile(null); };

  const pick = (f: File | null) => {
    setFile(f);
    if (f && !name) {
      const base = f.name.replace(/\.[^.]+$/, '').replace(/\(.*?\)/g, '').replace(/[_]+/g, ' ').trim();
      setName(base);
      setCode(base.split(/\s+/).map((w) => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'CUTOVER');
    }
  };

  const submit = async () => {
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) { setError('Please save the sheet as CSV first (Excel: File → Save a copy → CSV UTF-8).'); return; }
    setBusy(true); setError(null);
    try {
      const text = await file.text();
      const r = await api.post<Report>('/cutover/import', text, {
        params: { name, code, startAt: replan ? new Date(startAt).toISOString() : undefined },
        headers: { 'Content-Type': 'text/csv' },
      });
      setReport(r.data);
      await refreshProjects();
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover">
        ⇪ Import from Excel
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="imp-h">
          <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-card bg-surface p-5 shadow-card">
            <div className="flex items-start gap-3">
              <div className="mr-auto">
                <h3 id="imp-h" className="text-lg font-semibold text-text-primary">Import a cutover sheet</h3>
                <p className="text-xs text-text-secondary">The "Cutover Activities" tab saved as CSV. Sections, teams, assignees, times, statuses and comments come across; problems are reported, not hidden.</p>
              </div>
              <button type="button" onClick={close} aria-label="Close" className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
            </div>

            {!report ? (
              <div className="mt-4 space-y-3">
                <label className="block text-sm">
                  <span className="text-text-secondary">Sheet (.csv)</span>
                  <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0] ?? null)} className={`${input} mt-1`} />
                </label>
                <div className="grid grid-cols-[1fr_140px] gap-3">
                  <label className="block text-sm"><span className="text-text-secondary">Project name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} className={`${input} mt-1`} /></label>
                  <label className="block text-sm"><span className="text-text-secondary">Code</span>
                    <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className={`${input} mt-1 font-mono`} /></label>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={replan} onChange={(e) => setReplan(e.target.checked)} className="mt-1" />
                  <span><span className="text-text-primary">Re-plan for a new cutover night</span>
                    <span className="block text-xs text-text-secondary">Moves every task by the same amount so the first "Deployment" task starts at this time. Untick to keep the sheet's dates (past tasks become due straight away).</span></span>
                </label>
                {replan && <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className={input} aria-label="Cutover start" />}
                <p className="text-xs text-text-secondary">Sheet times are read as US Central (CST/CDT). Start-time alerts stay <b>off</b> for the new project.</p>
                {error && <p className="text-sm text-rose-700" role="alert">{error}</p>}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={close} className="rounded-lg border border-border-strong px-3 py-2 text-sm">Cancel</button>
                  <button type="button" onClick={submit} disabled={!file || !name || !code || busy}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Importing…' : 'Import'}</button>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3 text-sm">
                <p className="text-text-primary"><b>{report.imported} tasks</b> imported into <b>{report.project.code}</b> · {report.project.name}
                  {report.shiftedByDays !== null && <span className="text-text-secondary"> (moved {report.shiftedByDays} days)</span>}</p>
                <div className="flex flex-wrap gap-2">
                  {report.sections.map((s) => <span key={s.name} className="rounded-full bg-surface-hover px-2 py-0.5 text-xs">{s.name}: {s.tasks}</span>)}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    ['Owner clashes', report.clashes, report.clashes ? 'text-rose-700' : 'text-emerald-700'],
                    ['Sheet errors', report.problems.length, report.problems.length ? 'text-rose-700' : 'text-emerald-700'],
                    ['0:00 checkpoints', report.checkpoints, 'text-violet-700'],
                    ['No end (N/A)', report.noEstimate, 'text-amber-700'],
                  ].map(([l, v, c]) => (
                    <div key={l as string} className="rounded-lg border border-border p-2"><p className="text-[11px] text-text-secondary">{l}</p><p className={`text-xl font-bold ${c}`}>{v}</p></div>
                  ))}
                </div>
                {report.problems.length > 0 && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
                    <p className="font-semibold mb-1">Found in the sheet — Excel didn't flag these</p>
                    <ul className="space-y-1 max-h-48 overflow-y-auto">
                      {report.problems.map((p, i) => <li key={i}><b>Row {p.row} · {p.ref}</b> {p.task}: {p.issue}</li>)}
                    </ul>
                  </div>
                )}
                {report.durationMismatches > 0 && (
                  <p className="text-xs text-text-secondary">{report.durationMismatches} rows have an "Estimated Duration" that doesn't match their start and end. DeployFlow works the duration out from the times, so it can't go stale.</p>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={close} className="rounded-lg border border-border-strong px-3 py-2 text-sm">Close</button>
                  <button type="button" onClick={() => { setSelectedProjectId(report.project.id); close(); }}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white">Open its timeline</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
