import express, { Router } from 'express';
import auth from '../../middleware/auth';
import validate from '../../middleware/validate';
import * as c from './controller';
import { commentSchema, createChangeSchema, setProjectSchema, transitionSchema } from './validators';

// Everything for the Change Request module is mounted under /api/change-requests.
const router = Router();
router.use(auth);

router.get('/', c.list);
router.get('/meta', c.meta);
router.get('/conflicts', c.conflicts);
router.post('/', validate(createChangeSchema), c.create);
router.get('/:id', c.getById);
router.post('/:id/transition', validate(transitionSchema), c.transition);
router.post('/:id/comments', validate(commentSchema), c.comment);
router.put('/:id/project', validate(setProjectSchema), c.setProject);
router.post('/:id/attachments', express.raw({ type: () => true, limit: '10mb' }), c.upload);
router.get('/:id/attachments/:attachmentId', c.download);

export default router;
