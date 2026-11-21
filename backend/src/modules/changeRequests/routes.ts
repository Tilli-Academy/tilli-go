import express, { Router } from 'express';
import auth from '../../middleware/auth';
import validate from '../../middleware/validate';
import { requirePermission } from '../auth/permissions';
import * as c from './controller';
import {
  commentSchema, createChangeSchema, decisionSchema, documentSchema, linkSchema, setProjectSchema, transitionSchema, updateChangeSchema,
} from './validators';

// Everything for the Change Request module is mounted under /api/change-requests.
// Each write needs a permission; workflow moves check theirs in the service
// (transition: per move, decision: cr.decide, new project: project.manage).
const router = Router();
router.use(auth);
const edit = requirePermission('cr.edit');

router.get('/', c.list);
router.get('/meta', c.meta);
router.get('/conflicts', c.conflicts);
router.post('/', requirePermission('cr.create'), validate(createChangeSchema), c.create);
router.get('/:id', c.getById);
router.patch('/:id', edit, validate(updateChangeSchema), c.update);
router.post('/:id/transition', validate(transitionSchema), c.transition);
router.post('/:id/decision', validate(decisionSchema), c.decide);
router.post('/:id/comments', validate(commentSchema), c.comment);
router.put('/:id/project', edit, validate(setProjectSchema), c.setProject);
router.put('/:id/documents/:typeId', edit, validate(documentSchema), c.setDocument);
router.delete('/:id/documents/:typeId', edit, c.removeDocument);
router.post('/:id/links', edit, validate(linkSchema), c.addLink);
router.delete('/:id/links/:otherId', edit, c.removeLink);
router.post('/:id/attachments', edit, express.raw({ type: () => true, limit: '10mb' }), c.upload);
router.get('/:id/attachments/:attachmentId', c.download);

export default router;
