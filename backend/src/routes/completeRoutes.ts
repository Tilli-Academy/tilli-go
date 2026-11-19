import { Router } from 'express';
import * as completeController from '../controllers/completeController';
import rateLimiter from '../middleware/rateLimiter';

const router = Router();

// Public endpoints (no JWT auth) — protected by signed token + rate limiting.
// 15 requests per IP per minute to prevent brute-force token guessing.
const limit = () => rateLimiter({ windowMs: 60_000, max: 15, keyPrefix: 'rl:complete' });

// Read-only: what the confirm page shows. Opening a link never changes anything,
// so email scanners and link previews can't complete a task.
router.get('/preview', limit(), completeController.preview);
router.get('/', limit(), completeController.preview);
// The owner clicked "Mark as completed".
router.post('/', limit(), completeController.complete);

export = router;
