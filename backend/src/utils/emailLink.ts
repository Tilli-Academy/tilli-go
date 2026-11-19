import type { Request } from 'express';
import logger from '../config/logger';
import { verifyAckToken } from './token';
import type { AckTokenData } from '../types';

// Shared by the acknowledge and complete links (email → confirm page → API).
//
// The token is read from the X-Link-Token header or the request body. Those never
// reach access logs, unlike a URL query string. The query string (?token=) is still
// accepted so older clients and API tests keep working, and Nginx logs paths without
// query strings, so a token sent that way isn't logged either.

export type LinkOutcome = { status: number; body: Record<string, unknown> };

export function readLinkParams(req: Request): { taskId?: string; token?: string } {
  const body = (req.body as Record<string, unknown> | undefined) ?? {};
  const query = req.query as Record<string, unknown>;
  const header = req.get('x-link-token');
  const pick = (...vals: unknown[]) => vals.find((v): v is string => typeof v === 'string' && v.length > 0);
  return { taskId: pick(body.task_id, query.task_id), token: pick(header, body.token, query.token) };
}

/** Signature, expiry and task are checked; the token itself is never logged. */
export function checkLinkToken(taskId?: string, token?: string, kind = 'Link'): { data?: AckTokenData; fail?: LinkOutcome } {
  if (!taskId || !token) return { fail: { status: 400, body: { error: 'Missing task_id or token' } } };
  try {
    return { data: verifyAckToken(taskId, token) };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ taskId, reason }, `${kind} token rejected`);
    // Malformed tokens can throw parser errors; don't echo those back.
    const known = ['Malformed token', 'Invalid token signature', 'Token expired', 'Token task ID mismatch'];
    return { fail: { status: 403, body: { error: known.includes(reason) ? reason : 'Invalid token' } } };
  }
}

/**
 * The link must name the task's current owner. Links without an owner (sent by the
 * old version) are refused: anyone holding one could otherwise act on a task that has
 * since been reassigned.
 */
export function ownerMismatch(data: AckTokenData, assignedUserId: string | null): LinkOutcome | null {
  if (!data.uid) return { status: 403, body: { error: 'This link does not name the task owner - ask for a new one' } };
  if (data.uid !== assignedUserId) return { status: 403, body: { error: 'This link was sent to a previous owner of the task' } };
  return null;
}
