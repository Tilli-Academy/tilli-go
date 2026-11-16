import { Router } from 'express';
import auth from '../../middleware/auth';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/errors';
import { canApprove } from '../changeRequests/workflow';
import { alertSettings } from './settings';
import { resetLivePlan } from './livePlan';

// Start-time alerts: per-project switch, alert status per task, activity feed.
// Mounted at /api/alerts. Emails themselves are only ever sent by the worker.
const router = Router();
router.use(auth);

const ALERT_ACTIONS = ['EMAIL_SENT', 'ALERT_NO_OWNER', 'ALERT_FAILED', 'ALERT_RETRY', 'ALERT_BLOCKED_DOMAIN'];

router.get('/projects/:projectId', async (req, res, next) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      select: { id: true, code: true, name: true, startAlertsEnabled: true },
    });
    if (!project) throw new AppError('Project not found', 404);

    const [tasks, events] = await Promise.all([
      prisma.task.findMany({
        where: { projectId: project.id },
        select: {
          id: true, sequenceNumber: true, taskName: true, status: true, plannedStartTime: true,
          assignedTeam: true, assignedUser: { select: { name: true } }, alert: true,
        },
        orderBy: { sequenceNumber: 'asc' },
      }),
      prisma.auditLog.findMany({
        where: {
          task: { projectId: project.id },
          OR: [{ action: { in: ALERT_ACTIONS } }, { field: 'status' }],
        },
        select: {
          id: true, action: true, field: true, oldValue: true, newValue: true, createdAt: true,
          task: { select: { sequenceNumber: true, taskName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 40,
      }),
    ]);

    const counts: Record<string, number> = {};
    for (const t of tasks) if (t.alert) counts[t.alert.status] = (counts[t.alert.status] ?? 0) + 1;

    res.json({
      project,
      canManage: canApprove(req.user!.role),
      demoTools: alertSettings.demoTools && canApprove(req.user!.role),
      settings: {
        fromAddress: alertSettings.fromAddress,
        replyTo: alertSettings.replyTo,
        timeZone: alertSettings.timeZone,
        allowedDomains: alertSettings.allowedDomains,
      },
      counts,
      tasks: tasks.map((t) => ({ ...t, code: `${project.code}-${t.sequenceNumber}` })),
      events: events.map((e) => ({
        id: e.id,
        at: e.createdAt,
        action: e.action,
        field: e.field,
        oldValue: e.oldValue,
        newValue: e.action === 'EMAIL_SENT' ? (e.newValue ?? '').replace(/\s*messageId=\S+/, '') : e.newValue,
        code: `${project.code}-${e.task.sequenceNumber}`,
        taskName: e.task.taskName,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/projects/:projectId', async (req, res, next) => {
  try {
    if (!canApprove(req.user!.role)) {
      throw new AppError('Only release managers can switch start-time alerts on or off', 403);
    }
    if (typeof req.body?.enabled !== 'boolean') throw new AppError('enabled must be true or false', 400);
    const project = await prisma.project.update({
      where: { id: req.params.projectId },
      data: { startAlertsEnabled: req.body.enabled },
      select: { id: true, startAlertsEnabled: true },
    }).catch(() => { throw new AppError('Project not found', 404); });
    res.json(project);
  } catch (err) {
    next(err);
  }
});

// Demo helper (DEMO_TOOLS=true only): rebuild a small cutover plan that starts
// in the next few minutes, so alerts can be shown firing live.
router.post('/demo/live-plan', async (req, res, next) => {
  try {
    if (!alertSettings.demoTools) throw new AppError('Not found', 404);
    if (!canApprove(req.user!.role)) throw new AppError('Only release managers can do this', 403);
    const project = await resetLivePlan();
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

export default router;
