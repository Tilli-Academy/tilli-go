import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import prisma from '../config/prisma';
import type { JwtTokenPayload } from '../types';

/**
 * Checks the Bearer token, then reads the user's CURRENT role from the database.
 * The role inside the token is ignored: if an admin is demoted (or the user is
 * deleted), that takes effect on their next request, not when the token expires.
 */
const auth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  let payload: JwtTokenPayload;
  try {
    payload = jwt.verify(header.slice(7), config.jwtSecret!) as JwtTokenPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, email: true, role: true } });
    if (!user) {
      res.status(401).json({ error: 'Account no longer exists' });
      return;
    }
    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
};

export = auth;
