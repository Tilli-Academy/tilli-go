import { Router } from 'express';
import { z } from 'zod';
import auth from '../../middleware/auth';
import validate from '../../middleware/validate';
import { hasPermission, requirePermission } from '../auth/permissions';
import * as lists from './service';

// Managed lists. Mounted at /api/lists.
//   GET    /                       active values (everyone); ?all=1 everything + usage (admin.lists)
//   POST   /:list                  add a value
//   PATCH  /values/:id             rename, recolour, (de)activate, mark required
//   PUT    /:list/order            reorder
//   DELETE /values/:id             remove a value nobody uses
const router = Router();
router.use(auth);

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must look like #1a2b3c').nullable().optional();
const addSchema = z.object({ label: z.string().trim().min(1).max(60), color, required: z.boolean().optional() }).strict();
const updateSchema = z
  .object({ label: z.string().trim().min(1).max(60).optional(), color, active: z.boolean().optional(), required: z.boolean().optional() })
  .strict();
const orderSchema = z.object({ ids: z.array(z.string().uuid()).min(1) }).strict();

router.get('/', async (req, res, next) => {
  try {
    const admin = req.query.all === '1' && (await hasPermission(req.user!, 'admin.lists'));
    res.json({ lists: await lists.all(admin), meta: lists.LISTS });
  } catch (err) {
    next(err);
  }
});

const admin = requirePermission('admin.lists', 'Only admins can change lists');
router.post('/:list', admin, validate(addSchema), (req, res, next) => {
  lists.add(req.params.list as string, req.body).then((v) => res.status(201).json(v), next);
});
router.patch('/values/:id', admin, validate(updateSchema), (req, res, next) => {
  lists.update(req.params.id as string, req.body).then((v) => res.json(v), next);
});
router.put('/:list/order', admin, validate(orderSchema), (req, res, next) => {
  lists.reorder(req.params.list as string, req.body.ids).then((v) => res.json(v), next);
});
router.delete('/values/:id', admin, (req, res, next) => {
  lists.remove(req.params.id as string).then(() => res.status(204).end(), next);
});

export default router;
