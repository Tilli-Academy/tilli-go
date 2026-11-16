import { Router } from 'express';
import auth from '../../middleware/auth';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/errors';
import { durationKind, findClashes, loadPlan, type PlanTask } from './rules';

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
      project: { id: project.id, code: project.code, name: project.name },
      tasks: tasks.map((t) => ({ ...t, durationKind: durationKind(t) })),
      dependencies: deps,
      clashes,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
