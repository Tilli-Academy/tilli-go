import { Router } from 'express';
import * as authController from '../controllers/authController';
import rateLimiter from '../middleware/rateLimiter';
import auth from '../middleware/auth';
import { permissionsFor } from '../modules/auth/permissions';

const router = Router();

router.post(
  '/register',
  rateLimiter({ windowMs: 60_000, max: 5, keyPrefix: 'rl:register' }),
  authController.register,
);
router.post(
  '/login',
  rateLimiter({ windowMs: 60_000, max: 10, keyPrefix: 'rl:login' }),
  authController.login,
);

// Microsoft OAuth routes (public — no JWT required)
router.get('/microsoft', authController.microsoftLogin);
router.get('/microsoft/callback', authController.microsoftCallback);
router.get('/microsoft/status', authController.microsoftStatus);

// Authenticated user profile
router.get('/me', auth, authController.getMe);
// What the signed-in user may do (the UI hides what they can't; the API enforces it)
router.get('/permissions', auth, (req, res, next) => {
  permissionsFor(req.user!).then((permissions) => res.json({ role: req.user!.role, permissions }), next);
});

export = router;
