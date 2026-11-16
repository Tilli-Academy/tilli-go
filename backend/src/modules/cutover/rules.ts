/**
 * Cutover planning rules (from the Excel cutover tracker, made explicit):
 *
 * 1. Tasks linked by a dependency run one by one, so they never clash.
 * 2. Tasks with no dependency between them may run in PARALLEL in the same
 *    time frame - but then they must not have the same owner: the same person,
 *    or (when no person is set on either) the same team.
 * 3. Durations are flexible: 0:00:00 (a milestone / checkpoint), minutes,
 *    days or weeks, or N/A (no end time). Long-running tasks (24h or more,
 *    e.g. "get approval from management") are waiting-type work and don't
 *    block their owner, so they are left out of the clash check.
 * 4. The end can never be before the start.
 *
 * The backend enforces these; the UI explains them.
 */
import prisma from '../../config/prisma';
import { AppError } from '../../utils/errors';

export const LONG_RUNNING_MS = 24 * 60 * 60 * 1000;

export interface PlanTask {
  id: string;
  sequenceNumber: number;
  taskName: string;
  status: string;
  assignedUserId: string | null;
  assignedTeam: string | null;
  plannedStartTime: Date | null;
  plannedEndTime: Date | null;
  ownerName?: string | null;
}

export type DurationKind = 'unscheduled' | 'no-estimate' | 'milestone' | 'timed' | 'long-running';

export function durationKind(t: Pick<PlanTask, 'plannedStartTime' | 'plannedEndTime'>): DurationKind {
  if (!t.plannedStartTime) return 'unscheduled';
  if (!t.plannedEndTime) return 'no-estimate';
  const ms = t.plannedEndTime.getTime() - t.plannedStartTime.getTime();
  if (ms === 0) return 'milestone';
  return ms >= LONG_RUNNING_MS ? 'long-running' : 'timed';
}

export function assertEndAfterStart(start: Date | null | undefined, end: Date | null | undefined): void {
  if (start && end && end.getTime() < start.getTime()) {
    throw new AppError('Planned end cannot be before planned start (use the same time for a 0:00 checkpoint, or leave the end empty for N/A)', 400);
  }
}

function sameOwner(a: PlanTask, b: PlanTask): boolean {
  if (a.assignedUserId || b.assignedUserId) return !!a.assignedUserId && a.assignedUserId === b.assignedUserId;
  const ta = a.assignedTeam?.trim().toLowerCase();
  const tb = b.assignedTeam?.trim().toLowerCase();
  return !!ta && ta === tb;
}

/** Only short, scheduled, unfinished tasks occupy their owner. */
function occupiesOwner(t: PlanTask): boolean {
  const k = durationKind(t);
  return t.status !== 'Completed' && (k === 'timed' || k === 'milestone' || k === 'no-estimate');
}

function overlaps(a: PlanTask, b: PlanTask): boolean {
  const as = a.plannedStartTime!.getTime();
  const bs = b.plannedStartTime!.getTime();
  const ae = a.plannedEndTime?.getTime() ?? as;
  const be = b.plannedEndTime?.getTime() ?? bs;
  if (ae === as && be === bs) return as === bs; // two checkpoints at the same moment
  if (ae === as) return bs <= as && as < be; // checkpoint inside the other task
  if (be === bs) return as <= bs && bs < ae;
  return as < be && bs < ae;
}

/** Edges: taskId -> ids it depends on. Returns "a and b are linked by a dependency chain". */
function linkedBy(edges: Map<string, string[]>) {
  const reach = new Map<string, Set<string>>();
  const from = (id: string): Set<string> => {
    const cached = reach.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(edges.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(edges.get(n) ?? []));
    }
    reach.set(id, seen);
    return seen;
  };
  return (a: string, b: string) => from(a).has(b) || from(b).has(a);
}

export interface Clash { a: PlanTask; b: PlanTask }

export function findClashes(tasks: PlanTask[], edges: Map<string, string[]>): Clash[] {
  const linked = linkedBy(edges);
  const busy = tasks.filter(occupiesOwner);
  const out: Clash[] = [];
  for (let i = 0; i < busy.length; i++) {
    for (let j = i + 1; j < busy.length; j++) {
      const a = busy[i]!;
      const b = busy[j]!;
      if (sameOwner(a, b) && overlaps(a, b) && !linked(a.id, b.id)) out.push({ a, b });
    }
  }
  return out;
}

export async function loadPlan(projectId: string) {
  const [tasks, deps] = await Promise.all([
    prisma.task.findMany({
      where: { projectId },
      select: {
        id: true, sequenceNumber: true, taskName: true, status: true, system: true, description: true,
        assignedUserId: true, assignedTeam: true, plannedStartTime: true, plannedEndTime: true,
        actualStartTime: true, actualEndTime: true,
        assignedUser: { select: { name: true, email: true } },
        alert: { select: { status: true, sentAt: true, acknowledgedAt: true, recipient: true } },
      },
      orderBy: { sequenceNumber: 'asc' },
    }),
    prisma.taskDependency.findMany({ where: { task: { projectId } }, select: { taskId: true, dependsOnTaskId: true } }),
  ]);
  const edges = new Map<string, string[]>();
  for (const d of deps) edges.set(d.taskId, [...(edges.get(d.taskId) ?? []), d.dependsOnTaskId]);
  return { tasks, deps, edges };
}

/**
 * Called by taskService before saving a create/update that touches time, owner or
 * dependencies. `candidate.id` is absent for a new task; `dependencyIds` (if given)
 * replaces the candidate's dependencies.
 */
export async function assertNoOwnerClash(
  candidate: Omit<PlanTask, 'id'> & { id?: string; projectId: string },
  dependencyIds?: string[],
): Promise<void> {
  assertEndAfterStart(candidate.plannedStartTime, candidate.plannedEndTime);
  if (!occupiesOwner({ ...candidate, id: candidate.id ?? "__new__" })) return;

  const { tasks, edges } = await loadPlan(candidate.projectId);
  const others: PlanTask[] = tasks
    .filter((t) => t.id !== candidate.id)
    .map((t) => ({ ...t, ownerName: t.assignedUser?.name ?? t.assignedTeam }));
  const id = candidate.id ?? '__new__';
  if (dependencyIds) edges.set(id, dependencyIds);

  const clash = findClashes([{ ...candidate, id }, ...others], edges).find((c) => c.a.id === id || c.b.id === id);
  if (clash) {
    const other = clash.a.id === id ? clash.b : clash.a;
    const project = await prisma.project.findUnique({ where: { id: candidate.projectId }, select: { code: true } });
    const who = other.ownerName ?? 'the same owner';
    throw new AppError(
      `Parallel task clash with ${project?.code ?? ''}-${other.sequenceNumber} "${other.taskName}": both run at the same time and are owned by ${who}. ` +
        'Assign a different person/team, change the time, or add a dependency if one must wait for the other.',
      409,
    );
  }
}
