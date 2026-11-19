import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import api, { getErrorMessage } from '../../services/api';
import type { AcknowledgeResponse } from '../../types';
import { whenWithUtc } from '../../utils/zoneTime';

// Confirm page for the start-time alert email.
// Opening the link only READS (preview) — nothing changes until the owner clicks
// "Acknowledge & start", so email security scanners can't acknowledge by accident.

interface Preview {
  code: string;
  taskName: string;
  system: string;
  assignedTeam: string | null;
  status: string;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  actualStartTime: string | null;
  projectName: string;
  timeZone: string;
  assignedUser: { name: string } | null;
  earlierSteps: { code: string; taskName: string; status: string; completedAt: string | null }[];
}

type View = 'loading' | 'ready' | 'saving' | 'done' | 'error';


export default function AcknowledgePage() {
  const [params] = useSearchParams();
  const taskId = params.get('task_id');
  const token = params.get('token');
  const [view, setView] = useState<View>('loading');
  const [task, setTask] = useState<Preview | null>(null);
  const [result, setResult] = useState<AcknowledgeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId || !token) {
      setView('error');
      setError('Invalid acknowledgement link — missing task_id or token.');
      return;
    }
    let alive = true;
    api.get<Preview>('/acknowledge/preview', { params: { task_id: taskId, token } })
      .then((r) => {
        if (!alive) return;
        setTask(r.data);
        if (r.data.status === 'Acknowledged' || r.data.status === 'Completed') {
          setResult({ message: `Task already ${r.data.status.toLowerCase()}`, taskId, taskName: r.data.taskName, status: r.data.status, actualStartTime: r.data.actualStartTime } as AcknowledgeResponse);
          setView('done');
        } else setView('ready');
      })
      .catch((e) => { if (alive) { setView('error'); setError(getErrorMessage(e)); } });
    return () => { alive = false; };
  }, [taskId, token]);

  const confirm = async () => {
    setView('saving');
    try {
      const r = await api.post<AcknowledgeResponse>('/acknowledge', null, { params: { task_id: taskId, token } });
      setResult(r.data);
      setView('done');
    } catch (e) {
      setError(getErrorMessage(e));
      setView('ready');
    }
  };

  const notReady = task && task.status !== 'Triggered';

  return (
    <div className="flex items-center justify-center min-h-screen bg-surface-alt p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="bg-surface rounded-card shadow-card p-6 sm:p-8 w-full max-w-[440px]"
      >
        <h1 className="text-sm font-semibold text-text-secondary tracking-widest uppercase mb-5 text-center">Tilli-go</h1>

        {view === 'loading' && (
          <div className="flex flex-col items-center gap-4">
            <motion.div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full"
              animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
            <p className="text-sm text-text-secondary">Loading your task…</p>
          </div>
        )}

        {(view === 'ready' || view === 'saving') && task && (
          <div>
            <h2 className="text-lg font-semibold text-text-primary text-center">Confirm you're starting this task</h2>
            <dl className="mt-4 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-text-secondary">Task</dt><dd className="font-semibold text-text-primary">{task.code} · {task.taskName}</dd>
              <dt className="text-text-secondary">Project</dt><dd className="text-text-primary">{task.projectName}</dd>
              <dt className="text-text-secondary">Planned start</dt><dd className="text-text-primary">{whenWithUtc(task.plannedStartTime, task.timeZone)}</dd>
              <dt className="text-text-secondary">Owner</dt><dd className="text-text-primary">{task.assignedUser?.name ?? '—'}{task.assignedTeam ? ` (${task.assignedTeam})` : ''}</dd>
            </dl>
            {task.earlierSteps.length > 0 && (
              <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                <p className="font-semibold mb-1">Earlier steps</p>
                {task.earlierSteps.map((s) => (
                  <p key={s.code}>{s.status === 'Completed' || s.status === 'N/A' ? '✓' : '…'} {s.code} · {s.taskName} — {s.status}</p>
                ))}
              </div>
            )}
            {notReady && (
              <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                This task is <b>{task.status}</b>, so it can't be acknowledged yet. You'll get an email when it is ready to start.
              </p>
            )}
            {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
            <button type="button" onClick={confirm} disabled={view === 'saving' || !!notReady}
              className="mt-5 w-full h-11 rounded-lg bg-primary text-white font-semibold hover:opacity-90 disabled:opacity-50">
              {view === 'saving' ? 'Acknowledging task...' : 'Acknowledge & start'}
            </button>
            <p className="mt-3 text-xs text-text-secondary">
              Link expires 12 hours after the planned end.
            </p>
          </div>
        )}

        {view === 'done' && result && (
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}
            className="flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 rounded-full bg-accent-light text-emerald-800 flex items-center justify-center text-2xl font-bold">&#10003;</div>
            <h2 className="text-lg font-semibold text-text-primary">
              {result.message === 'Task acknowledged successfully' ? "You're on it — task acknowledged" : result.message}
            </h2>
            <dl className="w-full grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm text-left mt-2">
              <dt className="text-text-secondary">Task</dt><dd className="text-text-primary">{task?.code ? `${task.code} · ` : ''}{result.taskName}</dd>
              <dt className="text-text-secondary">Status</dt><dd><span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-violet-100 text-violet-800">{result.status}</span></dd>
              {result.actualStartTime && (<><dt className="text-text-secondary">Actual start</dt><dd className="text-text-primary">{whenWithUtc(result.actualStartTime, task?.timeZone ?? 'UTC')}</dd></>)}
            </dl>
            <p className="text-xs text-text-secondary mt-2">Mark it Completed in Tilli-go when you're done.</p>
          </motion.div>
        )}

        {view === 'error' && (
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}
            className="flex flex-col items-center gap-4 text-center">
            <div className="w-12 h-12 rounded-full bg-destructive-light text-red-800 flex items-center justify-center text-2xl font-bold">&#10007;</div>
            <h2 className="text-lg font-semibold text-red-800">Acknowledgement Failed</h2>
            <p className="text-sm text-text-secondary">{error}</p>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
