import { Router } from 'express';
import * as projectController from '../controllers/projectController';
import validate from '../middleware/validate';
import { createProjectSchema, updateProjectSchema } from '../validators/projectValidator';
import auth from '../middleware/auth';
import { requirePermission } from '../modules/auth/permissions';

const router = Router();

router.use(auth);

router.get('/', projectController.list);
router.get('/:id', projectController.getById);
router.post('/', requirePermission('project.manage'), validate(createProjectSchema), projectController.create);
router.patch('/:id', requirePermission('project.manage'), validate(updateProjectSchema), projectController.update);
router.post('/batch-delete', requirePermission('project.manage'), projectController.removeMany);
router.delete('/:id', requirePermission('project.manage'), projectController.remove);

export = router;
