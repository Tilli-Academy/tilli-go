import { Router } from 'express';
import * as acknowledgeController from '../controllers/acknowledgeController';
import rateLimiter from '../middleware/rateLimiter';

const router = Router();

// Public endpoints (no JWT auth) — protected by signed token + rate limiting.
// 15 requests per IP per minute to prevent brute-force token guessing.
const limit = () => rateLimiter({ windowMs: 60_000, max: 15, keyPrefix: 'rl:ack' });

// Read-only: what the confirm page shows. Opening a link never changes anything.
router.get('/preview', limit(), acknowledgeController.preview);
// The owner clicked "Acknowledge & start".
router.post('/', limit(), acknowledgeController.acknowledgePost);
// Older emails linked here directly; still works.
router.get('/', limit(), acknowledgeController.acknowledge);

export = router;
