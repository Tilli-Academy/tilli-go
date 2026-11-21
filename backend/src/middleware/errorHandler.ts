import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../config/logger';
import { AppError } from '../utils/errors';

const errorHandler = (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
  if (err instanceof AppError) {
    logger.warn({ status: err.status, message: err.message }, 'App error');
    res.status(err.status).json({ error: err.message });
    return;
  }

  if (err instanceof ZodError) {
    const messages = err.issues.map((i) => i.message);
    res.status(400).json({ error: messages.join(', ') });
    return;
  }

  // Errors from express.json / express.raw (body too large, broken JSON) carry their own status.
  const bodyError = err as Error & { type?: string; status?: number; limit?: number };
  if (bodyError.type === 'entity.too.large') {
    const mb = bodyError.limit ? Math.round(bodyError.limit / (1024 * 1024)) : null;
    res.status(413).json({ error: mb ? `File is larger than ${mb} MB` : 'Request is too large' });
    return;
  }
  if (bodyError.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body is not valid JSON' });
    return;
  }

  logger.error(err, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
};

export default errorHandler;
