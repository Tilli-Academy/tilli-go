import express, { Router } from 'express';
import auth from '../../middleware/auth';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/errors';
import { durationKind, findClashes, loadPlan, type PlanTask } from './rules';
import { importCutoverSheet } from './importSheet';

// Read-only planning view of a cutover project: tasks, dependencies,
// duration kinds and owner clashes. Mounted at /api/cutover.
const router = Router();
router.use(auth);

router.get('/:projectId/timeline', async (req, res, next) => {
  try {
    const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
    if (!project) throw new AppError('Project not found', 404);
    const { tasks, deps, edges } = await loadPlan(project.id);
    const plan: PlanTask[] = tasks.map((t) => ({ ...t, ownerName: t.assignedUser?.name ?? t.assignedTeam }));
    const clashes = findClashes(plan, edges).map((c) => ({ a: c.a.id, b: c.b.id }));
    res.json({
      project: { id: project.id, code: project.code, name: project.name, startAlertsEnabled: project.startAlertsEnabled },
      tasks: tasks.map((t) => ({ ...t, durationKind: durationKind(t) })),
      dependencies: deps,
      clashes,
    });
  } catch (err) {
    next(err);
  }
});

// Import a cutover sheet (CSV saved from Excel) as a new project.
// Body: the CSV text. Query: name, code, startAt (optional ISO date to move the plan).
router.post('/import', express.text({ type: () => true, limit: '5mb' }), async (req, res, next) => {
  try {
    if (typeof req.body !== 'string' || !req.body.trim()) throw new AppError('Send the CSV file as the request body', 400);
    const q = req.query as Record<string, string | undefined>;
    const report = await importCutoverSheet(req.body, { name: q.name ?? '', code: q.code ?? '', startAt: q.startAt || undefined });
    res.status(201).json(report);
  } catch (err) {
    next(err);
  }
});

export default router;
