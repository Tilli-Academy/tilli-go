import { useContext, useEffect, useMemo, useState } from 'react';
import { dayIn, dayKeyIn, startOfDayIn, timeIn, whenWithUtc, zoneLabel, zoneOffsetMs } from '../../utils/zoneTime';
import { ProjectContext } from '../../App';
import api, { getErrorMessage } from '../../services/api';
import { durationKind, formatDuration, type DurationKind } from './duration';
import AlertsPanel from '../alerts/AlertsPanel';
import { alertLabel, hhmm, type TaskAlertInfo } from '../alerts/alertMeta';

interface TTask {
  id: string;
  sequenceNumber: number;
  taskName: string;
  system: string;
  status: string;
  assignedTeam: string | null;
  assignedUser: { name: string; email: string } | null;
  plannedStartTime: string | null;
  plannedEndTime: string | null;
  alert: TaskAlertInfo | null;
}
interface TimelineData {
  project: { id: string; code: string; name: string; startAlertsEnabled: boolean; timeZone: string };
  tasks: TTask[];
  dependencies: { taskId: string; dependsOnTaskId: string }[];
  clashes: { a: string; b: string }[];
}

const NO_ESTIMATE_VISUAL_MS = 30 * 60000; // how wide an N/A task is drawn
const STATUS: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-900 border-amber-300',
  Triggered: 'bg-sky-100 text-sky-900 border-sky-300',
  Acknowledged: 'bg-violet-100 text-violet-900 border-violet-300',
  Completed: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  Blocked: 'bg-rose-100 text-rose-900 border-rose-300',
};
const STEPS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * 60000);

const owner = (t: TTask) => t.assignedUser?.name ?? t.assignedTeam ?? 'Unassigned';
const ms = (s: string) => new Date(s).getTime();

function visualSpan(t: TTask): [number, number] {
  const s = ms(t.plannedStartTime!);
  return [s, t.plannedEndTime ? ms(t.plannedEndTime) : s + NO_ESTIMATE_VISUAL_MS];
}

export default function Timeline() {
  const { selectedProjectId, projects } = useContext(ProjectContext);
  const [data, setData] = useState<TimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(null);

  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!selectedProjectId) return;
    setData(null); setSelected(null); setRange('');
  }, [selectedProjectId]);

  // Load, then refresh quietly so statuses and alerts update live during a cutover.
  useEffect(() => {
    if (!selectedProjectId) return;
    let alive = true;
    const load = () => api.get<TimelineData>(`/cutover/${selectedProjectId}/timeline`)
      .then((r) => { if (alive) { setData(r.data); setError(null); } })
      .catch((e) => { if (alive) setError(getErrorMessage(e)); });
    load();
    const h = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(h); };
  }, [selectedProjectId, reload]);

  const model = useMemo(() => {
    if (!data) return null;
    const byId = new Map(data.tasks.map((t) => [t.id, t]));
    const deps = new Map<string, string[]>();
    const dependents = new Map<string, string[]>();
    for (const d of data.dependencies) {
      deps.set(d.taskId, [...(deps.get(d.taskId) ?? []), d.dependsOnTaskId]);
      dependents.set(d.dependsOnTaskId, [...(dependents.get(d.dependsOnTaskId) ?? []), d.taskId]);
    }
    const reach = (id: string, g: Map<string, string[]>) => {
      const seen = new Set<string>(); const st = [...(g.get(id) ?? [])];
      while (st.length) { const n = st.pop()!; if (!seen.has(n)) { seen.add(n); st.push(...(g.get(n) ?? [])); } }
      return seen;
    };
    const upstream = new Map(data.tasks.map((t) => [t.id, reach(t.id, deps)]));
    const linked = (a: string, b: string) => upstream.get(a)!.has(b) || upstream.get(b)!.has(a);

    const scheduled = data.tasks.filter((t) => t.plannedStartTime);
    const parallelWith = new Map<string, string[]>();
    for (const a of scheduled) {
      const [as, ae] = visualSpan(a);
      parallelWith.set(a.id, scheduled.filter((b) => {
        if (b.id === a.id || linked(a.id, b.id)) return false;
        const [bs, be] = visualSpan(b);
        return as < be && bs < ae;
      }).map((b) => b.id));
    }
    const clashOf = new Map<string, string[]>();
    for (const c of data.clashes) {
      clashOf.set(c.a, [...(clashOf.get(c.a) ?? []), c.b]);
      clashOf.set(c.b, [...(clashOf.get(c.b) ?? []), c.a]);
    }
    // longest one-by-one chain (number of tasks)
    const memo = new Map<string, number>();
    const depth = (id: string): number => {
      if (memo.has(id)) return memo.get(id)!;
      memo.set(id, 1);
      const v = 1 + Math.max(0, ...(deps.get(id) ?? []).map(depth));
      memo.set(id, v);
      return v;
    };
    const longestChain = Math.max(0, ...data.tasks.map((t) => depth(t.id)));

    // Multi-day (waiting) tasks would squash the go-live window, so zoom ranges ignore them.
    const focus = scheduled.filter((t) => durationKind(t.plannedStartTime, t.plannedEndTime) !== 'long-running');
    const days = new Map<string, number>();
    const tz = data.project.timeZone;
    for (const t of focus.length ? focus : scheduled) days.set(dayKeyIn(t.plannedStartTime!, tz), (days.get(dayKeyIn(t.plannedStartTime!, tz)) ?? 0) + 1);
    const busiestDay = [...days.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'all';
    const lo = Math.min(...scheduled.map((t) => visualSpan(t)[0]));
    const hi = Math.max(...scheduled.map((t) => visualSpan(t)[1]));
    return { byId, deps, dependents, upstream, parallelWith, clashOf, longestChain, scheduled, focus, days, busiestDay, lo, hi };
  }, [data]);

  if (!selectedProjectId) return <Empty text="Select a project (top right) to see its cutover timeline." />;
  if (error) return <Empty text={error} />;
  if (!data || !model) return <Empty text="Loading…" />;
  if (model.scheduled.length === 0) return <Empty text="No scheduled tasks yet. Give tasks a planned start in the Tasks grid." />;

  // visible window: default = the go-live day (busiest day)
  const tz = data.project.timeZone;
  const view = range || model.busiestDay;
  let from = model.lo, to = model.hi;
  if (view !== 'all') {
    const dayStart = startOfDayIn(view, tz);
    const pool = model.focus.length ? model.focus : model.scheduled;
    const inDay = pool.filter((t) => dayKeyIn(t.plannedStartTime!, tz) === view).map(visualSpan);
    from = Math.min(...inDay.map(([s]) => s), dayStart + 86400000);
    to = Math.max(...inDay.map(([, e]) => e), from + 60 * 60000);
  }
  const pad = Math.max((to - from) * 0.04, 10 * 60000);
  from -= pad; to += pad;
  const span = to - from;
  const step = STEPS.find((s) => span / s <= 10) ?? STEPS[STEPS.length - 1]!;
  const ticks: number[] = [];
  // Ticks fall on whole hours / midnights of the project's zone, not UTC.
  const off = zoneOffsetMs(from, tz);
  for (let t = Math.ceil((from + off) / step) * step - off; t <= to; t += step) ticks.push(t);
  const pct = (n: number) => ((n - from) / span) * 100;

  // lanes by owner, with stacked sub-rows so parallel work is visible side by side
  const lanes = new Map<string, TTask[]>();
  for (const t of [...model.scheduled].sort((a, b) => ms(a.plannedStartTime!) - ms(b.plannedStartTime!))) {
    const [s, e] = visualSpan(t);
    if (e < from || s > to) continue;
    lanes.set(owner(t), [...(lanes.get(owner(t)) ?? []), t]);
  }
  const laneRows = [...lanes.entries()].map(([name, list]) => {
    // Stack by REAL times: a new row only when two tasks truly overlap.
    const rows: { end: number; tasks: TTask[] }[] = [];
    for (const t of list) {
      const [s, e] = visualSpan(t);
      const row = rows.find((r) => r.end <= s);
      if (row) { row.tasks.push(t); row.end = Math.max(e, s); } else rows.push({ end: Math.max(e, s), tasks: [t] });
    }
    return { name, rows };
  });

  const sel = selected ? model.byId.get(selected) ?? null : null;
  const related = new Set<string>(sel ? [sel.id, ...(model.deps.get(sel.id) ?? []), ...(model.dependents.get(sel.id) ?? []), ...(model.clashOf.get(sel.id) ?? [])] : []);
  const parallelCount = [...model.parallelWith.values()].filter((l) => l.length > 0).length;
  const unscheduled = data.tasks.filter((t) => !t.plannedStartTime);
  const now = Date.now();
  const project = projects.find((p) => p.id === selectedProjectId);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 sm:p-6 space-y-5 max-w-[1400px] mx-auto">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Cutover timeline · {project?.code ?? data.project.code}</h2>
          <p className="text-xs text-text-muted" title={tz}>Times in {zoneLabel(tz)} ({tz})</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            ['Tasks', data.tasks.length, 'text-text-primary'],
            ['Running in parallel', parallelCount, 'text-sky-700'],
            ['Longest one-by-one chain', model.longestChain, 'text-violet-700'],
            ['Owner clashes', data.clashes.length, data.clashes.length ? 'text-rose-700' : 'text-emerald-700'],
            ['Not scheduled', unscheduled.length, 'text-amber-700'],
          ].map(([l, v, c]) => (
            <div key={l as string} className="bg-surface border border-border rounded-card shadow-card p-3">
              <p className="text-xs font-medium text-text-secondary">{l}</p>
              <p className={`text-2xl font-bold ${c}`}>{v}</p>
            </div>
          ))}
        </div>

        {data.clashes.length > 0 && (
          <div className="rounded-card border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800" role="alert">
            <b>⚠ Same owner on parallel tasks:</b>{' '}
            {data.clashes.map((c, i) => {
              const a = model.byId.get(c.a)!; const b = model.byId.get(c.b)!;
              return <span key={i}>{i > 0 && ' · '}#{a.sequenceNumber} & #{b.sequenceNumber} ({owner(a)})</span>;
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary mr-1">Zoom</span>
          <Chip on={view === 'all'} onClick={() => setRange('all')}>Whole plan</Chip>
          {[...model.days.entries()].sort().map(([d, n]) => (
            <Chip key={d} on={view === d} onClick={() => setRange(d)}>
              {dayIn(startOfDayIn(d, tz) + 12 * 3600000, tz)} · {n} task{n > 1 ? 's' : ''}{d === model.busiestDay ? ' · go-live' : ''}
            </Chip>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-text-secondary">
            <Legend kind="timed" /> <Legend kind="milestone" /> <Legend kind="long-running" /> <Legend kind="no-estimate" />
            <span className="flex items-center gap-1"><span className="inline-block h-3 w-5 rounded border-2 border-rose-500" />clash</span>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
          <div className="bg-surface border border-border rounded-card shadow-card overflow-x-auto">
            <div className="min-w-[760px]">
              {/* time axis */}
              <div className="relative ml-40 h-9 border-b border-border">
                {ticks.map((t) => (
                  <span key={t} className="absolute top-2 -translate-x-1/2 text-[11px] text-text-muted whitespace-nowrap" style={{ left: `${pct(t)}%` }}>
                    {step >= 86400000 || timeIn(t, tz) === '00:00' ? dayIn(t, tz) : timeIn(t, tz)}
                  </span>
                ))}
              </div>
              {laneRows.map(({ name, rows }) => (
                <div key={name} className="flex border-b border-border last:border-b-0">
                  <div className="w-40 flex-shrink-0 px-3 py-2 text-sm font-medium text-text-primary border-r border-border bg-surface-hover/40">
                    {name}
                    {rows.length > 1 && <span className="block text-[11px] font-normal text-sky-700">{rows.length} overlapping (multi-day / waiting work)</span>}
                  </div>
                  <div className="relative flex-1">
                    {ticks.map((t) => <span key={t} className="absolute inset-y-0 border-l border-dashed border-border/70" style={{ left: `${pct(t)}%` }} />)}
                    {now > from && now < to && <span className="absolute inset-y-0 border-l-2 border-rose-400 z-10" style={{ left: `${pct(now)}%` }} title="Now" />}
                    {rows.map((r, ri) => (
                      <div key={ri} className="relative h-10">
                        {r.tasks.map((t) => (
                          <Bar key={t.id} t={t} pct={pct} from={from} to={to}
                            clash={model.clashOf.has(t.id)}
                            dim={!!sel && !related.has(t.id)}
                            role={!sel ? null : t.id === sel.id ? 'self' : (model.deps.get(sel.id) ?? []).includes(t.id) ? 'dep' : (model.dependents.get(sel.id) ?? []).includes(t.id) ? 'blocks' : 'clash'}
                            onClick={() => setSelected(t.id === selected ? null : t.id)} />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <aside className="bg-surface border border-border rounded-card shadow-card p-4 text-sm h-fit lg:sticky lg:top-4">
            {!sel ? (
              <p className="text-text-secondary">Select a task to see what it waits for and what it blocks.</p>
            ) : (
              <TaskPanel t={sel} model={model} code={data.project.code} tz={tz} onPick={setSelected} />
            )}
          </aside>
        </div>

        <AlertsPanel projectId={data.project.id} timeZone={tz} onChanged={() => setReload((n) => n + 1)} />

        {unscheduled.length > 0 && (
          <div className="bg-surface border border-border rounded-card shadow-card p-4">
            <p className="text-sm font-semibold text-text-primary mb-2">Not scheduled yet ({unscheduled.length})</p>
            <div className="flex flex-wrap gap-2">
              {unscheduled.map((t) => <span key={t.id} className="rounded-md border border-dashed border-border-strong px-2 py-1 text-xs text-text-secondary">#{t.sequenceNumber} {t.taskName} · {owner(t)}</span>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Bar({ t, pct, from, to, clash, dim, role, onClick }: {
  t: TTask; pct: (n: number) => number; from: number; to: number; clash: boolean; dim: boolean;
  role: 'self' | 'dep' | 'blocks' | 'clash' | null; onClick: () => void;
}) {
  const kind = durationKind(t.plannedStartTime, t.plannedEndTime);
  const [s, e] = visualSpan(t);
  const ring = role === 'self' ? 'ring-2 ring-primary' : role === 'dep' ? 'ring-2 ring-sky-500' : role === 'blocks' ? 'ring-2 ring-violet-500' : '';
  const label = `#${t.sequenceNumber} ${t.taskName} · ${t.status} · ${formatDuration(t.plannedStartTime, t.plannedEndTime)}${t.alert ? ` · alert: ${alertLabel(t.alert).label}` : ''}`;
  const base = `absolute top-1.5 h-7 cursor-pointer transition-opacity ${dim ? 'opacity-25' : ''} ${ring}`;

  if (kind === 'milestone') {
    return (
      <button type="button" onClick={onClick} title={label} aria-label={label}
        className={`${base} w-5 -translate-x-1/2 flex items-center justify-center`} style={{ left: `${pct(s)}%` }}>
        <span className={`h-4 w-4 rotate-45 border-2 ${clash ? 'border-rose-500 bg-rose-200' : 'border-violet-600 bg-violet-300'}`} />
      </button>
    );
  }
  const left = Math.max(pct(s), 0);
  const right = Math.min(pct(e), 100);
  const style: React.CSSProperties = { left: `${left}%`, width: `max(${right - left}%, 6px)` };
  const look: React.CSSProperties = {};
  if (kind === 'long-running') look.backgroundImage = 'repeating-linear-gradient(135deg, rgba(255,255,255,.55) 0 6px, transparent 6px 12px)';
  if (kind === 'no-estimate') look.maskImage = look.WebkitMaskImage = 'linear-gradient(90deg, #000 55%, transparent)';
  // The bar is often too short for the name, so hovering or focusing shows it in full straight away.
  return (
    <div className={`group absolute top-1.5 h-7 ${dim ? 'opacity-25' : ''} hover:z-20 focus-within:z-20`} style={style}>
      <button type="button" onClick={onClick} aria-label={label}
        className={`h-full w-full cursor-pointer transition-opacity ${ring} rounded-md border text-left px-1.5 text-[11px] font-medium truncate ${STATUS[t.status] ?? STATUS.Pending} ${clash ? '!border-2 !border-rose-500' : ''}`}
        style={look}>
        {s < from && '◀ '}{t.alert && <span aria-hidden="true">{alertLabel(t.alert).icon} </span>}#{t.sequenceNumber} {t.taskName}{e > to && ' ▶'}
      </button>
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-0 mb-1 hidden max-w-xs whitespace-normal rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg group-hover:block group-focus-within:block">
        {label}
      </span>
    </div>
  );
}

function TaskPanel({ t, model, code, tz, onPick }: { t: TTask; model: any; code: string; tz: string; onPick: (id: string) => void }) {
  const list = (ids: string[] = [], tone: string) =>
    ids.length === 0 ? <p className="text-text-muted">None</p> : ids.map((id) => {
      const x: TTask = model.byId.get(id);
      return <button key={id} type="button" onClick={() => onPick(id)} className={`block w-full text-left truncate rounded px-2 py-1 mb-1 ${tone} hover:underline`}>#{x.sequenceNumber} {x.taskName}</button>;
    });
  const kind = durationKind(t.plannedStartTime, t.plannedEndTime);
  return (
    <div className="space-y-3">
      <div>
        <p className="font-mono text-xs text-text-muted">{code}-{t.sequenceNumber} · {t.system}</p>
        <p className="font-semibold text-text-primary">{t.taskName}</p>
        <p className="text-xs text-text-secondary mt-1">{owner(t)} · {t.status}</p>
      </div>
      <div className="rounded-md bg-surface-hover p-2 text-xs space-y-0.5">
        <p>Start: <b>{whenWithUtc(t.plannedStartTime, tz, '-')}</b></p>
        <p>End: <b>{whenWithUtc(t.plannedEndTime, tz, 'N/A')}</b></p>
        <p>Duration: <b>{formatDuration(t.plannedStartTime, t.plannedEndTime)}</b>{kind === 'long-running' && ' - long-running, does not block the owner'}{kind === 'milestone' && ' - a checkpoint'}</p>
      </div>
      {(() => {
        const a = alertLabel(t.alert, t.status);
        return (
          <div className={`rounded-md border p-2 text-xs ${a.cls}`}>
            <p className="font-semibold">{a.icon} Start-time alert: {a.label}</p>
            {t.alert?.recipient && <p className="mt-0.5 break-all">To {t.alert.recipient}{t.alert.sentAt ? ` at ${hhmm(t.alert.sentAt, tz)}` : ''}{t.alert.acknowledgedAt ? ` · started ${hhmm(t.alert.acknowledgedAt, tz)}` : ''}</p>}
            {a.hint && <p className="mt-0.5 opacity-80">{a.hint}</p>}
          </div>
        );
      })()}
      {model.clashOf.has(t.id) && <div><p className="text-xs font-semibold text-rose-700 mb-1">Clashes (same owner, same time)</p>{list(model.clashOf.get(t.id), 'bg-rose-50 text-rose-800')}</div>}
      <div><p className="text-xs font-semibold text-sky-700 mb-1">Waits for</p>{list(model.deps.get(t.id), 'bg-sky-50 text-sky-800')}</div>
      <div><p className="text-xs font-semibold text-violet-700 mb-1">Blocks</p>{list(model.dependents.get(t.id), 'bg-violet-50 text-violet-800')}</div>
      <div><p className="text-xs font-semibold text-text-secondary mb-1">Runs in parallel with</p>{list(model.parallelWith.get(t.id), 'bg-surface-hover text-text-primary')}</div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`rounded-full px-3 py-1 text-xs font-medium border transition ${on ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border-strong hover:bg-surface-hover'}`}>{children}</button>;
}

function Legend({ kind }: { kind: DurationKind }) {
  if (kind === 'milestone') return <span className="flex items-center gap-1" title="Zero-length step, e.g. Go / No-Go"><span className="inline-block h-2.5 w-2.5 rotate-45 border-2 border-violet-600 bg-violet-300" />0:00 checkpoint</span>;
  const style: React.CSSProperties = kind === 'long-running' ? { backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,.6) 0 3px, transparent 3px 6px)' }
    : kind === 'no-estimate' ? { maskImage: 'linear-gradient(90deg,#000 40%,transparent)', WebkitMaskImage: 'linear-gradient(90deg,#000 40%,transparent)' } : {};
  const text = kind === 'long-running' ? 'multi-day' : kind === 'no-estimate' ? 'no estimate (N/A)' : 'timed task';
  const help = kind === 'long-running' ? '24 h or more, e.g. waiting for an approval. Does not block its owner.' : kind === 'no-estimate' ? 'No planned end' : 'Bars in one row run one after another';
  return <span className="flex items-center gap-1" title={help}><span className="inline-block h-3 w-5 rounded border border-sky-300 bg-sky-200" style={style} />{text}</span>;
}

function Empty({ text }: { text: string }) {
  return <div className="flex-1 overflow-y-auto p-6"><p className="text-sm text-text-secondary">{text}</p></div>;
}
