import type { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { checkLinkToken, ownerMismatch, readLinkParams } from '../utils/emailLink';
import type { CompleteSuccessResponse } from '../types';

// "Mark complete" link from the completion email. Same pattern as acknowledge:
//   GET  /api/complete(/preview) — read-only details for the confirm page
//   POST /api/complete           — the owner clicked "Mark as completed"
// Opening a link never changes anything (email scanners open links). The link names
// the owner it was sent to and only works while that person still owns the task.

export const preview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { taskId, token } = readLinkParams(req);
    const { data, fail } = checkLinkToken(taskId, token, 'complete');
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
    const { taskId, token } = readLinkParams(req);
    const { data, fail } = checkLinkToken(taskId, token, 'complete');
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

    // One conditional update ("only if still Acknowledged and still this owner"), so a
    // reassignment or a second click at the same moment can't slip in between.
    const now = new Date();
    const userId = data!.uid ?? null;
    const updated = await prisma.$transaction(async (tx) => {
      const claim = await tx.task.updateMany({
        where: { id: task.id, status: 'Acknowledged', assignedUserId: data!.uid },
        data: { status: 'Completed', actualEndTime: now },
      });
      if (claim.count === 0) return null;
      await tx.auditLog.createMany({
        data: [
          { taskId: task.id, action: 'UPDATED', field: 'status', oldValue: 'Acknowledged', newValue: 'Completed', userId },
          { taskId: task.id, action: 'UPDATED', field: 'actualEndTime', oldValue: null, newValue: now.toISOString(), userId },
        ],
      });
      return tx.task.findUniqueOrThrow({ where: { id: task.id } });
    });
    if (!updated) {
      // Lost the race: answer for the task as it is now.
      const current = await prisma.task.findUnique({
        where: { id: task.id },
        select: { id: true, status: true, taskName: true, actualEndTime: true, assignedUserId: true },
      });
      const changedOwner = current && ownerMismatch(data!, current.assignedUserId);
      if (!current) { res.status(404).json({ error: 'Task not found' }); return; }
      if (changedOwner) { res.status(changedOwner.status).json(changedOwner.body); return; }
      if (current.status === 'Completed') {
        const body: CompleteSuccessResponse = {
          message: 'Task already completed', taskId: current.id, taskName: current.taskName, status: current.status, actualEndTime: current.actualEndTime,
        };
        res.status(200).json(body);
        return;
      }
      res.status(409).json({ error: `Cannot complete - task is ${current.status}`, currentStatus: current.status });
      return;
    }
    logger.info({ taskId: task.id, taskName: task.taskName }, 'Task completed via email link');

    const body: CompleteSuccessResponse = {
      message: 'Task completed successfully', taskId: updated.id, taskName: updated.taskName, status: updated.status, actualEndTime: updated.actualEndTime,
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
};
