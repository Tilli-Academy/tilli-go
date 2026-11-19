import { Router } from 'express';
import taskRoutes from './taskRoutes';
import authRoutes from './authRoutes';
import acknowledgeRoutes from './acknowledgeRoutes';
import completeRoutes from './completeRoutes';
import projectRoutes from './projectRoutes';
import changeRequestRoutes from '../modules/changeRequests/routes';
import cutoverRoutes from '../modules/cutover/routes';
import alertRoutes from '../modules/alerts/routes';
import auth from '../middleware/auth';
import { requirePermission } from '../modules/auth/permissions';
import listRoutes from '../modules/lists/routes';
import * as scheduler from '../services/schedulerService';

const router = Router();

router.use('/auth', authRoutes);
router.use('/tasks', taskRoutes);
router.use('/projects', projectRoutes);
router.use('/change-requests', changeRequestRoutes);
router.use('/cutover', cutoverRoutes);
router.use('/alerts', alertRoutes);
router.use('/lists', listRoutes);
router.use('/acknowledge', acknowledgeRoutes);
router.use('/complete', completeRoutes);

router.get('/scheduler/status', auth, (_req, res) => {
  res.json(scheduler.getStats());
});

// Manual trigger for testing — POST only
router.post('/scheduler/trigger', auth, requirePermission('cutover.manage'), async (_req, res, next) => {
  try {
    await scheduler.tick();
    res.json(scheduler.getStats());
  } catch (err) {
    next(err);
  }
});

export = router;
