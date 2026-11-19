import type { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { canTaskExecute } from '../services/dependencyService';
import { checkLinkToken, ownerMismatch, readLinkParams, type LinkOutcome } from '../utils/emailLink';
import type { AcknowledgeSuccessResponse, AckTokenData } from '../types';

/**
 * Acknowledge a Triggered task: Triggered → Acknowledged, records the real start
 * time, marks the start-time alert as acknowledged. Safe to call twice.
 *
 * The change is ONE conditional update ("only if still Triggered and still owned by
 * the person the link was sent to"), so a reassignment or a second click that lands
 * at the same moment can't slip between the check and the save.
 */
async function acknowledgeTask(taskId: string, tokenData: AckTokenData): Promise<LinkOutcome> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, taskName: true, actualStartTime: true, assignedUserId: true },
  });
  if (!task) return { status: 404, body: { error: 'Task not found' } };
  const notOwner = ownerMismatch(tokenData, task.assignedUserId);
  if (notOwner) return notOwner;

  if (task.status === 'Acknowledged' || task.status === 'Completed') return already(task);
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
    const claim = await tx.task.updateMany({
      where: { id: taskId, status: 'Triggered', assignedUserId: tokenData.uid },
      data: { status: 'Acknowledged', actualStartTime: now },
    });
    if (claim.count === 0) return null; // someone else changed it first
    await tx.auditLog.createMany({
      data: [
        { taskId, action: 'UPDATED', field: 'status', oldValue: 'Triggered', newValue: 'Acknowledged', userId },
        { taskId, action: 'UPDATED', field: 'actualStartTime', oldValue: null, newValue: now.toISOString(), userId },
      ],
    });
    await tx.taskAlert.updateMany({ where: { taskId }, data: { status: 'ACKNOWLEDGED', acknowledgedAt: now } });
    return tx.task.findUniqueOrThrow({ where: { id: taskId } });
  });

  if (!updated) {
    // Lost the race: answer for the task as it is now.
    const current = await prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, taskName: true, actualStartTime: true, assignedUserId: true },
    });
    if (!current) return { status: 404, body: { error: 'Task not found' } };
    const changedOwner = ownerMismatch(tokenData, current.assignedUserId);
    if (changedOwner) return changedOwner;
    if (current.status === 'Acknowledged' || current.status === 'Completed') return already(current);
    return { status: 409, body: { error: `Cannot acknowledge — task is ${current.status}`, currentStatus: current.status } };
  }

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

function already(task: { id: string; status: string; taskName: string; actualStartTime: Date | null }): LinkOutcome {
  const body: AcknowledgeSuccessResponse = {
    message: `Task already ${task.status.toLowerCase()}`,
    taskId: task.id,
    taskName: task.taskName,
    status: task.status,
    actualStartTime: task.actualStartTime,
  };
  return { status: 200, body: { ...body } };
}

/** POST /api/acknowledge — the owner clicked "Acknowledge & start". */
export const acknowledgePost = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { taskId, token } = readLinkParams(req);
    const { data, fail } = checkLinkToken(taskId, token, 'Ack');
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
    const { taskId, token } = readLinkParams(req);
    const { data: tokenData, fail } = checkLinkToken(taskId, token, 'Ack');
    if (fail) { res.status(fail.status).json(fail.body); return; }

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        assignedUserId: true,
        id: true, sequenceNumber: true, taskName: true, system: true, assignedTeam: true, status: true,
        plannedStartTime: true, plannedEndTime: true, actualStartTime: true, notes: true, description: true,
        assignedUser: { select: { name: true } },
        project: { select: { code: true, name: true, timeZone: true } },
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
      timeZone: project.timeZone,
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
