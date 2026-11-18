import type { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { verifyAckToken } from '../utils/token';
import { canTaskExecute } from '../services/dependencyService';
import type { AcknowledgeSuccessResponse, AckTokenData } from '../types';

type Outcome = { status: number; body: Record<string, unknown> };

function readParams(req: Request): { taskId?: string; token?: string } {
  const src = { ...(req.query as Record<string, unknown>), ...((req.body as Record<string, unknown>) ?? {}) };
  return {
    taskId: typeof src.task_id === 'string' ? src.task_id : undefined,
    token: typeof src.token === 'string' ? src.token : undefined,
  };
}

function checkToken(taskId: string | undefined, token: string | undefined): { data?: AckTokenData; fail?: Outcome } {
  if (!taskId || !token) return { fail: { status: 400, body: { error: 'Missing task_id or token' } } };
  try {
    return { data: verifyAckToken(taskId, token) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ taskId, reason: message }, 'Ack token rejected');
    return { fail: { status: 403, body: { error: message } } };
  }
}

/**
 * Acknowledge a Triggered task: Triggered → Acknowledged, records the real start
 * time, marks the start-time alert as acknowledged. Safe to call twice.
 */
/** A link names the owner it was sent to; after a reassignment only the new owner's link works. */
function ownerMismatch(tokenData: AckTokenData, assignedUserId: string | null): Outcome | null {
  if (tokenData.uid && tokenData.uid !== assignedUserId) {
    return { status: 403, body: { error: 'This link was sent to a previous owner of the task' } };
  }
  return null;
}

async function acknowledgeTask(taskId: string, tokenData: AckTokenData): Promise<Outcome> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, taskName: true, actualStartTime: true, assignedUserId: true },
  });
  if (!task) return { status: 404, body: { error: 'Task not found' } };
  const notOwner = ownerMismatch(tokenData, task.assignedUserId);
  if (notOwner) return notOwner;

  if (task.status === 'Acknowledged' || task.status === 'Completed') {
    const body: AcknowledgeSuccessResponse = {
      message: `Task already ${task.status.toLowerCase()}`,
      taskId: task.id,
      taskName: task.taskName,
      status: task.status,
      actualStartTime: task.actualStartTime,
    };
    return { status: 200, body: { ...body } };
  }

  if (task.status !== 'Triggered') {
    return { status: 409, body: { error: `Cannot acknowledge — task is ${task.status}`, currentStatus: task.status } };
  }

  const depCheck = await canTaskExecute(taskId);
  if (!depCheck.executable) {
    const blockers = depCheck.blockingTasks.map((t) => `${t.taskName} (${t.status})`).join(', ');
    logger.warn({ taskId, blockers }, 'Ack blocked — dependencies not met');
    return {
      status: 409,
      body: { error: `Cannot acknowledge — dependencies not completed: ${blockers}`, blockingTasks: depCheck.blockingTasks },
    };
  }

  const now = new Date();
  const userId = tokenData.uid ?? null;
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.task.update({
      where: { id: taskId },
      data: { status: 'Acknowledged', actualStartTime: now },
    });
    await tx.auditLog.createMany({
      data: [
        { taskId, action: 'UPDATED', field: 'status', oldValue: 'Triggered', newValue: 'Acknowledged', userId },
        { taskId, action: 'UPDATED', field: 'actualStartTime', oldValue: null, newValue: now.toISOString(), userId },
      ],
    });
    await tx.taskAlert.updateMany({ where: { taskId }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: now } });
    return result;
  });

  logger.info({ taskId, taskName: task.taskName }, 'Task acknowledged');
  const body: AcknowledgeSuccessResponse = {
    message: 'Task acknowledged successfully',
    taskId: updated.id,
    taskName: updated.taskName,
    status: updated.status,
    actualStartTime: updated.actualStartTime,
  };
  return { status: 200, body: { ...body } };
}

/** POST /api/acknowledge — the owner clicked "Acknowledge & start". */
export const acknowledgePost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { taskId, token } = readParams(req);
    const { data, fail } = checkToken(taskId, token);
    if (fail) { res.status(fail.status).json(fail.body); return; }
    const out = await acknowledgeTask(taskId!, data!);
    res.status(out.status).json(out.body);
  } catch (err) {
    next(err);
  }
};


/**
 * GET /api/acknowledge/preview — read-only details for the confirm page.
 * Opening the link changes nothing, so email link scanners can't acknowledge.
 */
export const preview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { taskId, token } = readParams(req);
    const { data: tokenData, fail } = checkToken(taskId, token);
    if (fail) { res.status(fail.status).json(fail.body); return; }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        assignedUserId: true,
        id: true, sequenceNumber: true, taskName: true, system: true, assignedTeam: true, status: true,
        plannedStartTime: true, plannedEndTime: true, actualStartTime: true, notes: true, description: true,
        assignedUser: { select: { name: true } },
        project: { select: { code: true, name: true } },
        alert: { select: { status: true, sentAt: true, acknowledgedAt: true } },
        dependsOn: {
          select: { dependsOn: { select: { sequenceNumber: true, taskName: true, status: true, actualEndTime: true } } },
        },
      },
    });
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    const notOwner = ownerMismatch(tokenData!, task.assignedUserId);
    if (notOwner) { res.status(notOwner.status).json(notOwner.body); return; }

    const { dependsOn, project, assignedUserId: _owner, ...rest } = task;
    res.json({
      ...rest,
      code: `${project.code}-${task.sequenceNumber}`,
      projectCode: project.code,
      projectName: project.name,
      earlierSteps: dependsOn.map((d) => ({
        code: `${project.code}-${d.dependsOn.sequenceNumber}`,
        taskName: d.dependsOn.taskName,
        status: d.dependsOn.status,
        completedAt: d.dependsOn.actualEndTime,
      })),
    });
  } catch (err) {
    next(err);
  }
};
