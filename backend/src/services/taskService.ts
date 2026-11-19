import type { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { AppError } from '../utils/errors';
import { assertNoOwnerClash } from '../modules/cutover/rules';
import { assertDependenciesMet, validateDependencies, writeDependencies } from './dependencyService';
import { addReassignedJob } from './queueService';
import {
  TASK_INCLUDE,
  ALLOWED_TRANSITIONS,
  STATUS_REQUIRES_DEPS_MET,
  TaskStatus,
  LOCKED_STATUSES,
  DONE_STATUSES,
} from '../types';
import type {
  CreateTaskDTO,
  UpdateTaskDTO,
  TaskFilterParams,
  TaskResponse,
  TaskWithIncludes,
  PaginatedResponse,
  CreateAuditLogEntry,
  CreateTaskOptions,
  UpdateTaskOptions,
} from '../types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTask(task: TaskWithIncludes): TaskResponse {
  const { dependsOn, ...rest } = task;
  return {
    ...rest,
    dependencies: dependsOn.map((d) => d.dependsOnTaskId),
  };
}

function validateStatusTransition(current: string, next: string): void {
  if (current === next) return;

  const allowed = ALLOWED_TRANSITIONS[current as TaskStatus];
  if (!allowed || !allowed.has(next as TaskStatus)) {
    throw new AppError(`Invalid status transition: ${current} -> ${next}`, 400);
  }
}

// ── List ────────────────────────────────────────────────────────────────────

async function list(filters: TaskFilterParams = {}): Promise<PaginatedResponse<TaskResponse>> {
  const where: Prisma.TaskWhereInput = {};

  if (filters.status) {
    where.status = filters.status;
  }
  if (filters.system) {
    where.system = filters.system;
  }
  if (filters.assignedUserId) {
    where.assignedUserId = filters.assignedUserId;
  }
  if (filters.projectId) {
    where.projectId = filters.projectId;
  }

  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
  const skip = (page - 1) * limit;

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: TASK_INCLUDE,
      orderBy: { sequenceNumber: 'asc' },
      skip,
      take: limit,
    }),
    prisma.task.count({ where }),
  ]);

  return { data: (tasks as TaskWithIncludes[]).map(formatTask), total, page, limit };
}

// ── Get by ID ───────────────────────────────────────────────────────────────

async function getById(id: string): Promise<TaskResponse> {
  const task = await prisma.task.findUnique({
    where: { id },
    include: TASK_INCLUDE,
  });

  if (!task) {
    throw new AppError('Task not found', 404);
  }

  return formatTask(task as TaskWithIncludes);
}

// ── Create ──────────────────────────────────────────────────────────────────

async function create(data: CreateTaskDTO, opts: CreateTaskOptions = {}): Promise<TaskResponse> {
  const { dependencies, ...taskData } = data;
  const userId = opts.userId ?? null;

  if (!taskData.projectId) {
    throw new AppError('projectId is required', 400);
  }

  // Verify project exists
  const project = await prisma.project.findUnique({
    where: { id: taskData.projectId },
  });
  if (!project) {
    throw new AppError('Project not found', 404);
  }

  // Check dependencies before anything is saved (a bad list used to leave a half-made task).
  const deps = dependencies ? await validateDependencies(null, taskData.projectId, dependencies) : [];
  await assertChangeRequestInProject(taskData.changeRequestId, taskData.projectId);

  // Cutover planning rules: end >= start, and parallel tasks need different owners.
  await assertNoOwnerClash(
    {
      projectId: taskData.projectId,
      sequenceNumber: 0,
      taskName: taskData.taskName,
      status: TaskStatus.Pending,
      assignedUserId: taskData.assignedUserId ?? null,
      assignedTeam: taskData.assignedTeam ?? null,
      plannedStartTime: taskData.plannedStartTime ?? null,
      plannedEndTime: taskData.plannedEndTime ?? null,
    },
    dependencies,
  );

  // Generate sequenceNumber atomically within a transaction
  const task = await prisma.$transaction(async (tx) => {
    const lastTask = await tx.task.findFirst({
      where: { projectId: taskData.projectId },
      orderBy: { sequenceNumber: 'desc' },
    });

    const nextSeq = (lastTask?.sequenceNumber ?? 0) + 1;

    const created = await tx.task.create({
      data: {
        ...taskData,
        sequenceNumber: nextSeq,
      },
    });
    await tx.auditLog.create({ data: { taskId: created.id, action: 'CREATED', userId } });
    if (deps.length > 0) {
      await writeDependencies(tx, created.id, deps);
      await tx.auditLog.create({
        data: { taskId: created.id, action: 'UPDATED', field: 'dependencies', newValue: deps.join(','), userId },
      });
    }
    return tx.task.findUniqueOrThrow({ where: { id: created.id }, include: TASK_INCLUDE });
  });

  return formatTask(task as TaskWithIncludes);
}

// ── Update ──────────────────────────────────────────────────────────────────

async function update(id: string, data: UpdateTaskDTO, opts: UpdateTaskOptions = {}): Promise<TaskResponse> {
  const existing = await prisma.task.findUnique({
    where: { id },
    include: TASK_INCLUDE,
  });

  if (!existing) {
    throw new AppError('Task not found', 404);
  }

  if (LOCKED_STATUSES.has(existing.status)) {
    throw new AppError(existing.status === TaskStatus.Completed ? 'Cannot modify a completed task' : 'Cannot modify a task marked N/A', 400);
  }

  const { dependencies, ...taskFields } = data;

  // Defense-in-depth: reject projectId changes even if they somehow bypass Zod
  const rawData = data as Record<string, unknown>;
  if ('projectId' in rawData && rawData['projectId'] !== existing.projectId) {
    throw new AppError('Cannot change projectId after task creation', 400);
  }

  // Validate status transition
  if (taskFields.status && taskFields.status !== existing.status) {
    validateStatusTransition(existing.status, taskFields.status);

    // Defense-in-depth: verify dependency completion for advancing statuses.
    // The API middleware already checks, but the service layer must enforce
    // independently (scheduler and worker also call this service).
    if (STATUS_REQUIRES_DEPS_MET.has(taskFields.status)) {
      // Skip re-query if middleware already validated
      if (!opts.dependencyPreChecked) {
        await assertDependenciesMet(id);
      }
    }
  }

  // A task with no owner cannot start (reviewer decision): it can't be moved to
  // Triggered/Acknowledged without an owner, and a started task can't lose its owner.
  const nextStatus = taskFields.status ?? existing.status;
  const nextOwner = taskFields.assignedUserId !== undefined ? taskFields.assignedUserId : existing.assignedUserId;
  if (!nextOwner && (nextStatus === TaskStatus.Triggered || nextStatus === TaskStatus.Acknowledged)) {
    throw new AppError('Assign an owner before this task can start', 400);
  }

  const userId = opts.userId ?? null;

  // Changing only the start moves the whole task: the end shifts by the same amount
  // (the grid sends one field per edit, so "start later" used to fail "end before start").
  if (taskFields.plannedStartTime && !('plannedEndTime' in taskFields) && existing.plannedStartTime && existing.plannedEndTime) {
    const durationMs = existing.plannedEndTime.getTime() - existing.plannedStartTime.getTime();
    taskFields.plannedEndTime = new Date(new Date(taskFields.plannedStartTime).getTime() + durationMs);
  }

  // Check dependencies before the clash check trusts them, and before anything is saved.
  const deps = dependencies !== undefined ? await validateDependencies(id, existing.projectId, dependencies) : undefined;
  await assertChangeRequestInProject(taskFields.changeRequestId, existing.projectId);

  // Cutover planning rules - only when the schedule, owner or dependencies change,
  // so status-only updates from the scheduler/worker are never blocked.
  const PLAN_FIELDS = ['plannedStartTime', 'plannedEndTime', 'assignedUserId', 'assignedTeam'] as const;
  if (PLAN_FIELDS.some((f) => f in taskFields) || dependencies !== undefined) {
    const pick = <T,>(next: T | undefined, old: T): T => (next === undefined ? old : next);
    await assertNoOwnerClash(
      {
        id,
        projectId: existing.projectId,
        sequenceNumber: existing.sequenceNumber,
        taskName: pick(taskFields.taskName, existing.taskName),
        status: pick(taskFields.status, existing.status),
        assignedUserId: pick(taskFields.assignedUserId, existing.assignedUserId),
        assignedTeam: pick(taskFields.assignedTeam, existing.assignedTeam),
        plannedStartTime: pick(taskFields.plannedStartTime, existing.plannedStartTime),
        plannedEndTime: pick(taskFields.plannedEndTime, existing.plannedEndTime),
      },
      deps,
    );
  }

  // Build audit entries for changed fields.
  // Uses Record cast because we're iterating dynamic keys — the type system
  // can't statically verify which properties we're comparing, but at runtime
  // these are always valid Task field names from the validated UpdateTaskDTO.
  const existingRecord = existing as unknown as Record<string, unknown>;
  const auditEntries: CreateAuditLogEntry[] = [];

  for (const [key, value] of Object.entries(taskFields)) {
    const oldVal = existingRecord[key];
    if (oldVal !== value && value !== undefined) {
      auditEntries.push({
        taskId: id,
        action: 'UPDATED',
        field: key,
        oldValue: oldVal == null ? null : String(oldVal),
        newValue: value == null ? null : String(value),
        userId,
      });
    }
  }

  // Fields, dependencies and audit are saved together: if any part fails, nothing is saved.
  const oldDeps = (existing as TaskWithIncludes).dependsOn.map((d) => d.dependsOnTaskId).sort();
  const newDeps = deps ? [...deps].sort() : oldDeps;
  const depsChanged = deps !== undefined && (oldDeps.length !== newDeps.length || oldDeps.some((v, i) => v !== newDeps[i]));
  if (depsChanged) {
    auditEntries.push({
      taskId: id,
      action: 'UPDATED',
      field: 'dependencies',
      oldValue: oldDeps.join(',') || null,
      newValue: newDeps.join(',') || null,
      userId,
    });
  }
  const hasFieldUpdates = Object.keys(taskFields).length > 0;

  const updatedTask = await prisma.$transaction(async (tx) => {
    if (hasFieldUpdates) {
      await tx.task.update({ where: { id }, data: taskFields as Prisma.TaskUpdateInput });
    }
    if (depsChanged) {
      await writeDependencies(tx, id, newDeps);
    }
    if (auditEntries.length > 0) {
      await tx.auditLog.createMany({ data: auditEntries });
    }
    return tx.task.findUnique({ where: { id }, include: TASK_INCLUDE });
  });

  // A task that is already ready to start (Triggered) got a new owner: the worker
  // emails them if the project's alerts are on (one alert per task per owner).
  const ownerChanged = taskFields.assignedUserId !== undefined && taskFields.assignedUserId !== existing.assignedUserId;
  if (ownerChanged && updatedTask?.assignedUserId && updatedTask.status === TaskStatus.Triggered) {
    const project = await prisma.project.findUnique({ where: { id: existing.projectId }, select: { startAlertsEnabled: true } });
    if (project?.startAlertsEnabled) {
      await addReassignedJob(updatedTask).catch((err: unknown) =>
        logger.error({ taskId: id, err: err instanceof Error ? err.message : String(err) }, 'Could not queue the new owner alert'),
      );
    }
  }

  return formatTask(updatedTask as TaskWithIncludes);
}

/** A task can be tagged with a change request of its own project (or untagged with null). */
async function assertChangeRequestInProject(changeRequestId: string | null | undefined, projectId: string): Promise<void> {
  if (!changeRequestId) return;
  const cr = await prisma.changeRequest.findUnique({ where: { id: changeRequestId }, select: { projectId: true } });
  if (!cr || cr.projectId !== projectId) throw new AppError('The change request must belong to the same project as the task', 400);
}

// ── Delete ──────────────────────────────────────────────────────────────────

async function remove(id: string): Promise<void> {
  const existing = await prisma.task.findUnique({ where: { id } });

  if (!existing) {
    throw new AppError('Task not found', 404);
  }

  // Deleting a step would silently drop its links, so later steps that wait for it
  // could start too early. Refuse while any of them is still open; the user must
  // first remove the dependency (or finish / mark N/A those steps).
  await prisma.$transaction(async (tx) => {
    const waiting = await tx.taskDependency.findMany({
      where: { dependsOnTaskId: id, task: { status: { notIn: [...DONE_STATUSES] } } },
      select: { task: { select: { sequenceNumber: true, taskName: true, project: { select: { code: true } } } } },
    });
    if (waiting.length > 0) {
      const names = waiting.map((d) => `${d.task.project.code}-${d.task.sequenceNumber} ${d.task.taskName}`).join(', ');
      throw new AppError(`Cannot delete — these steps depend on this task: ${names}. Remove the dependency first.`, 409);
    }
    await tx.task.delete({ where: { id } });
  });

  logger.info({ taskId: id }, 'Task deleted');
}

export { list, getById, create, update, remove };
