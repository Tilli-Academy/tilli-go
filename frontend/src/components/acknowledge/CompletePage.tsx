import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import api, { getErrorMessage } from '../../services/api';
import type { CompleteResponse } from '../../types';
import { whenWithUtc } from '../../utils/zoneTime';

// Confirm page for the "mark complete" email link. Opening the link only READS
// (preview) — nothing changes until the owner clicks, so email scanners can't
// complete a task by accident. The link only works for the task's current owner.

interface Preview {
  code: string;
  taskName: string;
  system: string;
  status: string;
  plannedEndTime: string | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
  projectName: string;
  timeZone: string;
  assignedUser: { name: string } | null;
}

type View = 'loading' | 'ready' | 'saving' | 'done' | 'error';

export default function CompletePage() {
  const [params] = useSearchParams();
  const taskId = params.get('task_id');
  const token = params.get('token');
  const [view, setView] = useState<View>('loading');
  const [task, setTask] = useState<Preview | null>(null);
  const [result, setResult] = useState<CompleteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId || !token) {
      setView('error');
      setError('Invalid completion link — missing task_id or token.');
      return;
    }
    let alive = true;
    api.get<Preview>('/complete/preview', { params: { task_id: taskId, token } })
      .then((r) => {
        if (!alive) return;
        setTask(r.data);
        if (r.data.status === 'Completed') {
          setResult({ message: 'Task already completed', taskId, taskName: r.data.taskName, status: r.data.status, actualEndTime: r.data.actualEndTime } as CompleteResponse);
          setView('done');
        } else setView('ready');
      })
      .catch((e) => { if (alive) { setView('error'); setError(getErrorMessage(e)); } });
    return () => { alive = false; };
  }, [taskId, token]);

  const confirm = async () => {
    setView('saving');
    try {
      const r = await api.post<CompleteResponse>('/complete', null, { params: { task_id: taskId, token } });
      setResult(r.data);
      setView('done');
    } catch (e) {
      setError(getErrorMessage(e));
      setView('ready');
    }
  };

  const notReady = task && task.status !== 'Acknowledged';

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
            <h2 className="text-lg font-semibold text-text-primary text-center">Confirm this task is done</h2>
            <dl className="mt-4 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-text-secondary">Task</dt><dd className="font-semibold text-text-primary">{task.code} · {task.taskName}</dd>
              <dt className="text-text-secondary">Project</dt><dd className="text-text-primary">{task.projectName}</dd>
              <dt className="text-text-secondary">Started</dt><dd className="text-text-primary">{whenWithUtc(task.actualStartTime, task.timeZone)}</dd>
              <dt className="text-text-secondary">Planned end</dt><dd className="text-text-primary">{whenWithUtc(task.plannedEndTime, task.timeZone)}</dd>
              <dt className="text-text-secondary">Owner</dt><dd className="text-text-primary">{task.assignedUser?.name ?? '—'}</dd>
            </dl>
            {notReady && (
              <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                This task is <b>{task.status}</b>, so it can't be marked complete.
              </p>
            )}
            {error && <p className="mt-4 text-sm text-red-700" role="alert">{error}</p>}
            <button type="button" onClick={confirm} disabled={view === 'saving' || !!notReady}
              className="mt-5 w-full h-11 rounded-lg bg-primary text-white font-semibold hover:opacity-90 disabled:opacity-50">
              {view === 'saving' ? 'Completing task...' : 'Mark as completed'}
            </button>
          </div>
        )}

        {view === 'done' && result && (
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}
            className="flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 rounded-full bg-accent-light text-emerald-800 flex items-center justify-center text-2xl font-bold">&#10003;</div>
            <h2 className="text-lg font-semibold text-text-primary">
              {result.message === 'Task completed successfully' ? 'Done — task completed' : result.message}
            </h2>
            <dl className="w-full grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm text-left mt-2">
              <dt className="text-text-secondary">Task</dt><dd className="text-text-primary">{task?.code ? `${task.code} · ` : ''}{result.taskName}</dd>
              <dt className="text-text-secondary">Status</dt><dd><span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">{result.status}</span></dd>
              {result.actualEndTime && (<><dt className="text-text-secondary">Completed At</dt><dd className="text-text-primary">{whenWithUtc(result.actualEndTime, task?.timeZone ?? 'UTC')}</dd></>)}
            </dl>
          </motion.div>
        )}

        {view === 'error' && (
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}
            className="flex flex-col items-center gap-4 text-center">
            <div className="w-12 h-12 rounded-full bg-destructive-light text-red-800 flex items-center justify-center text-2xl font-bold">&#10007;</div>
            <h2 className="text-lg font-semibold text-red-800">Completion Failed</h2>
            <p className="text-sm text-text-secondary">{error}</p>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
