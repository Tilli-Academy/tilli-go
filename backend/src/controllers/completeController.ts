import type { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { verifyAckToken } from '../utils/token';
import type { AckTokenData, CompleteSuccessResponse } from '../types';

// "Mark complete" link from the completion email. Same pattern as acknowledge:
//   GET  /api/complete(/preview) — read-only details for the confirm page
//   POST /api/complete           — the owner clicked "Mark as completed"
// Opening a link never changes anything (email scanners open links). The link names
// the owner it was sent to and only works while that person still owns the task.

type Outcome = { status: number; body: Record<string, unknown> };

function readParams(req: Request): { taskId?: string; token?: string } {
  const src = { ...(req.query as Record<string, unknown>), ...((req.body as Record<string, unknown>) ?? {}) };
  return {
    taskId: typeof src.task_id === 'string' ? src.task_id : undefined,
    token: typeof src.token === 'string' ? src.token : undefined,
  };
}

function checkToken(taskId?: string, token?: string): { data?: AckTokenData; fail?: Outcome } {
  if (!taskId || !token) return { fail: { status: 400, body: { error: 'Missing task_id or token' } } };
  try {
    return { data: verifyAckToken(taskId, token) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ taskId, reason: message }, 'Complete token rejected');
    return { fail: { status: 403, body: { error: message } } };
  }
}

/** The link must name the task's current owner (links without one are refused). */
function ownerMismatch(data: AckTokenData, assignedUserId: string | null): Outcome | null {
  if (!data.uid) return { status: 403, body: { error: 'This link does not name the task owner - ask for a new one' } };
  if (data.uid !== assignedUserId) return { status: 403, body: { error: 'This link was sent to a previous owner of the task' } };
  return null;
}

export const preview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { taskId, token } = readParams(req);
    const { data, fail } = checkToken(taskId, token);
    if (fail) { res.status(fail.status).json(fail.body); return; }
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true, sequenceNumber: true, taskName: true, system: true, status: true, assignedUserId: true,
        plannedStartTime: true, plannedEndTime: true, actualStartTime: true, actualEndTime: true,
        assignedUser: { select: { name: true } },
        project: { select: { code: true, name: true, timeZone: true } },
      },
    });
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    const notOwner = ownerMismatch(data!, task.assignedUserId);
    if (notOwner) { res.status(notOwner.status).json(notOwner.body); return; }
    const { project, assignedUserId: _owner, ...rest } = task;
    res.json({ ...rest, code: `${project.code}-${task.sequenceNumber}`, projectName: project.name, timeZone: project.timeZone });
  } catch (err) {
    next(err);
  }
};

export const complete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { taskId, token } = readParams(req);
    const { data, fail } = checkToken(taskId, token);
    if (fail) { res.status(fail.status).json(fail.body); return; }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, taskName: true, actualEndTime: true, assignedUserId: true },
    });
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    const notOwner = ownerMismatch(data!, task.assignedUserId);
    if (notOwner) { res.status(notOwner.status).json(notOwner.body); return; }

    // Idempotent: a second click is harmless
    if (task.status === 'Completed') {
      const body: CompleteSuccessResponse = {
        message: 'Task already completed', taskId: task.id, taskName: task.taskName, status: task.status, actualEndTime: task.actualEndTime,
      };
      res.status(200).json(body);
      return;
    }
    // Only Acknowledged (started) tasks can be completed via this link
    if (task.status !== 'Acknowledged') {
      res.status(409).json({ error: `Cannot complete - task is ${task.status}`, currentStatus: task.status });
      return;
    }

    const now = new Date();
    const userId = data!.uid ?? null;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.task.update({ where: { id: task.id }, data: { status: 'Completed', actualEndTime: now } });
      await tx.auditLog.createMany({
        data: [
          { taskId: task.id, action: 'UPDATED', field: 'status', oldValue: 'Acknowledged', newValue: 'Completed', userId },
          { taskId: task.id, action: 'UPDATED', field: 'actualEndTime', oldValue: null, newValue: now.toISOString(), userId },
        ],
      });
      return result;
    });
    logger.info({ taskId: task.id, taskName: task.taskName }, 'Task completed via email link');

    const body: CompleteSuccessResponse = {
      message: 'Task completed successfully', taskId: updated.id, taskName: updated.taskName, status: updated.status, actualEndTime: updated.actualEndTime,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
};
