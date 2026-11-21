import { Router } from 'express';
import * as taskController from '../controllers/taskController';
import validate from '../middleware/validate';
import validateDependencies from '../middleware/validateDependencies';
import { createTaskSchema, updateTaskSchema } from '../validators/taskValidator';
import auth from '../middleware/auth';
import { requirePermission } from '../modules/auth/permissions';

const router = Router();

router.use(auth);

router.get('/', taskController.list);
router.get('/:id', taskController.getById);
router.get('/:id/dependencies', taskController.getDependencyStatus);
router.post('/', requirePermission('task.edit'), validate(createTaskSchema), taskController.create);
router.put(
  '/:id',
  requirePermission('task.edit'),
  validate(updateTaskSchema),
  validateDependencies,
  taskController.update,
);
router.delete('/:id', requirePermission('task.delete'), taskController.remove);

export = router;
