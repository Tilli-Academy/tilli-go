import { useCallback, useContext, useEffect, useState } from 'react';
import { ProjectContext } from '../../App';
import api, { getErrorMessage } from '../../services/api';
import { alertLabel, hhmm, type TaskAlertInfo } from './alertMeta';

interface AlertTaskRow {
  id: string;
  code: string;
  taskName: string;
  status: string;
  plannedStartTime: string | null;
  assignedTeam: string | null;
  assignedUser: { name: string } | null;
  alert: (TaskAlertInfo & { attempts: number }) | null;
}
interface AlertEvent {
  id: string;
  at: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  code: string;
  taskName: string;
}
interface AlertData {
  project: { id: string; code: string; name: string; startAlertsEnabled: boolean };
  canManage: boolean;
  demoTools: boolean;
  settings: { fromAddress: string; replyTo: string; timeZone: string; allowedDomains: string[] };
  counts: Record<string, number>;
  tasks: AlertTaskRow[];
  events: AlertEvent[];
}

const POLL_MS = 10_000;

function describe(e: AlertEvent): { text: string; tone: string } {
  switch (e.action) {
    case 'EMAIL_SENT':
      return { text: `Alert email sent ${(e.newValue ?? '').replace(/^to=/, 'to ').replace(/\sattempt=\d+/, '')}`, tone: 'bg-sky-500' };
    case 'ALERT_NO_OWNER': return { text: 'No owner set — release manager emailed instead', tone: 'bg-rose-500' };
    case 'ALERT_BLOCKED_DOMAIN': return { text: `${(e.newValue ?? '').replace(/^not sent/, 'Not sent')}`, tone: 'bg-rose-500' };
    case 'ALERT_RETRY': return { text: `Email failed, retrying: ${e.newValue ?? ''}`, tone: 'bg-amber-500' };
    case 'ALERT_FAILED': return { text: `Email failed for good: ${e.newValue ?? ''}`, tone: 'bg-rose-600' };
  }
  if (e.field === 'status') {
    if (e.oldValue === 'Pending' && e.newValue === 'Triggered') return { text: 'Start time reached, earlier steps done → Triggered', tone: 'bg-sky-500' };
    if (e.newValue === 'Blocked') return { text: 'Due, but waiting on an earlier step → Blocked', tone: 'bg-amber-500' };
    if (e.newValue === 'Acknowledged') return { text: 'Owner clicked Acknowledge & start → Acknowledged', tone: 'bg-violet-500' };
    if (e.newValue === 'Completed') return { text: 'Marked Completed', tone: 'bg-emerald-500' };
    return { text: `${e.oldValue} → ${e.newValue}`, tone: 'bg-slate-400' };
  }
  return { text: e.action, tone: 'bg-slate-400' };
}

export default function AlertsPanel({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const { refreshProjects, setSelectedProjectId } = useContext(ProjectContext);
  const [data, setData] = useState<AlertData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<AlertData>(`/alerts/projects/${projectId}`)
      .then((r) => { setData(r.data); setError(null); })
      .catch((e) => setError(getErrorMessage(e)));
  }, [projectId]);

  useEffect(() => {
    setData(null);
    load();
    const h = setInterval(load, POLL_MS);
    return () => clearInterval(h);
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); load(); onChanged(); } catch (e) { setError(getErrorMessage(e)); } finally { setBusy(null); }
  };

  if (!data) return error ? <p className="text-sm text-rose-700">{error}</p> : null;
  const on = data.project.startAlertsEnabled;
  const alerted = data.tasks.filter((t) => t.alert);
  const attention = (data.counts.NO_OWNER ?? 0) + (data.counts.BLOCKED_DOMAIN ?? 0) + (data.counts.FAILED ?? 0) + (data.counts.RETRYING ?? 0);

  return (
    <section className="bg-surface border border-border rounded-card shadow-card" aria-labelledby="alerts-h">
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
        <div className="mr-auto">
          <h3 id="alerts-h" className="text-base font-semibold text-text-primary">Start-time alerts</h3>
          <p className="text-xs text-text-secondary">When a task's planned start arrives and everything before it is done, its owner is emailed: "your task is ready to start now".</p>
        </div>
        {data.demoTools && (
          <button type="button" disabled={!!busy}
            onClick={() => run('demo', async () => {
              const r = await api.post<{ id: string }>('/alerts/demo/live-plan');
              await refreshProjects();
              setSelectedProjectId(r.data.id);
            })}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50">
            {busy === 'demo' ? 'Building…' : '▶ Start live rehearsal'}
          </button>
        )}
        {data.canManage && on && (
          <button type="button" disabled={!!busy} onClick={() => run('tick', () => api.post('/scheduler/trigger'))}
            title="The scheduler checks every minute on its own. This checks right now."
            className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover disabled:opacity-50">
            {busy === 'tick' ? 'Checking…' : '↻ Check now'}
          </button>
        )}
        <label className="flex items-center gap-2 text-sm">
          <span className={`text-xs font-semibold ${on ? 'text-primary' : 'text-text-muted'}`}>{on ? 'On' : 'Off'}</span>
          <button type="button" role="switch" aria-checked={on} aria-label="Start-time alerts"
            disabled={!data.canManage || !!busy}
            title={data.canManage ? '' : 'Only release managers can change this'}
            onClick={() => run('toggle', () => api.patch(`/alerts/projects/${projectId}`, { enabled: !on }))}
            className={`relative h-6 w-11 rounded-full border transition disabled:opacity-60 ${on ? 'bg-primary border-primary' : 'bg-surface-hover border-border-strong'}`}>
            <span className={`absolute top-0.5 left-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
          </button>
        </label>
      </div>

      {error && <p className="px-4 pt-3 text-sm text-rose-700" role="alert">{error}</p>}

      <div className="grid gap-4 p-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-3 min-w-0">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              ['Emailed', (data.counts.SENT ?? 0) + (data.counts.ACKNOWLEDGED ?? 0), 'text-sky-700'],
              ['Acknowledged', data.counts.ACKNOWLEDGED ?? 0, 'text-violet-700'],
              ['Awaiting click', data.counts.SENT ?? 0, 'text-amber-700'],
              ['Needs attention', attention, attention ? 'text-rose-700' : 'text-emerald-700'],
            ].map(([l, v, c]) => (
              <div key={l as string} className="rounded-lg border border-border p-2">
                <p className="text-[11px] font-medium text-text-secondary">{l}</p>
                <p className={`text-xl font-bold ${c}`}>{v}</p>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-hover text-[11px] uppercase tracking-wide text-text-secondary">
                <tr><th className="px-3 py-2 text-left">ID</th><th className="px-3 py-2 text-left">Task</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Start-time alert</th></tr>
              </thead>
              <tbody>
                {data.tasks.map((t) => {
                  const a = alertLabel(t.alert, t.status);
                  const when = t.alert?.status === 'ACKNOWLEDGED'
                    ? `emailed ${hhmm(t.alert.sentAt)} · started ${hhmm(t.alert.acknowledgedAt)}`
                    : t.alert?.sentAt ? `emailed ${hhmm(t.alert.sentAt)}` : t.alert?.status === 'RETRYING' ? `attempt ${t.alert.attempts}` : !t.alert && t.plannedStartTime && t.status === 'Pending' ? `planned ${hhmm(t.plannedStartTime)}` : '';
                  return (
                    <tr key={t.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs text-text-secondary whitespace-nowrap">{t.code}</td>
                      <td className="px-3 py-2 min-w-[160px]"><span className="font-medium text-text-primary">{t.taskName}</span><span className="block text-xs text-text-muted">{t.assignedUser?.name ?? `${t.assignedTeam ?? '—'} · no owner set`}</span></td>
                      <td className="px-3 py-2 text-xs text-text-secondary">{t.status}</td>
                      <td className="px-3 py-2">
                        <span title={a.hint} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${a.cls}`}>{a.icon} {a.label}</span>
                        {when && <span className="block text-[11px] text-text-muted mt-0.5">{when}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!on && alerted.length === 0 && (
            <p className="text-xs text-text-secondary">Alerts are <b>off</b> for this project, so planning and dry runs never email anyone. {data.canManage ? 'Switch them on when the cutover goes live.' : 'A release manager switches them on when the cutover goes live.'}</p>
          )}
        </div>

        <div className="space-y-3 min-w-0">
          <div className="rounded-lg border border-border p-3 text-xs space-y-1">
            <p className="font-semibold text-text-primary text-sm mb-1">Safety rules</p>
            <p>• <b>Off by default</b> — new projects never email anyone until switched on.</p>
            <p>• <b>Company addresses only</b> — {data.settings.allowedDomains.map((d) => `@${d}`).join(', ')}.</p>
            <p>• <b>One alert per task</b> — no duplicate emails.</p>
            <p>• <b>One click to confirm</b> — opening the link changes nothing, so email scanners can't confirm by accident.</p>
            <p className="pt-1 text-text-muted">From {data.settings.fromAddress} · replies to {data.settings.replyTo} · times in {data.settings.timeZone} and UTC</p>
          </div>
          <div className="rounded-lg border border-border">
            <p className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Alert history · updates every 10 s</p>
            <ul className="max-h-72 overflow-y-auto px-3 py-2 text-xs">
              {data.events.length === 0 && <li className="py-2 text-text-muted">Nothing yet. DeployFlow checks the plan every minute.</li>}
              {data.events.map((e) => {
                const d = describe(e);
                return (
                  <li key={e.id} className="grid grid-cols-[44px_10px_1fr] gap-2 py-1.5">
                    <span className="font-mono text-text-muted">{hhmm(e.at)}</span>
                    <span className={`mt-1 h-2 w-2 rounded-full ${d.tone}`} />
                    <span className="text-text-secondary min-w-0 break-words"><b className="font-mono text-text-primary">{e.code}</b> {d.text}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
