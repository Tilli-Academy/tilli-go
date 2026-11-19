import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError } from '../../utils/errors';
import * as service from './service';

// Small wrapper so every handler forwards errors to the shared errorHandler.
const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export const list = handle(async (req, res) => {
  res.json(
    await service.list(
      {
        status: str(req.query.status),
        product: str(req.query.product),
        q: str(req.query.q),
        mine: req.query.mine === '1',
        conflictsOnly: req.query.conflicts === '1',
        projectId: str(req.query.project),
      },
      req.user!,
    ),
  );
});

export const meta = handle(async (req, res) => {
  res.json(await service.meta(req.user!));
});

export const conflicts = handle(async (req, res) => {
  const product = str(req.query.product);
  const date = new Date(`${str(req.query.date) ?? ''}T00:00:00.000Z`);
  if (!product || isNaN(date.getTime())) {
    res.json({ conflicts: [] });
    return;
  }
  res.json({ conflicts: await service.findConflicts(product, date, str(req.query.exclude)) });
});

export const getById = handle(async (req, res) => {
  res.json(await service.getById(req.params.id as string, req.user!));
});

export const create = handle(async (req, res) => {
  res.status(201).json(await service.create(req.body, req.user!));
});

export const transition = handle(async (req, res) => {
  res.json(await service.transition(req.params.id as string, req.body.to, req.body.reason, req.user!));
});

export const comment = handle(async (req, res) => {
  res.status(201).json(await service.addComment(req.params.id as string, req.body.message, req.user!));
});

export const setProject = handle(async (req, res) => {
  res.json({ project: await service.setProject(req.params.id as string, req.body, req.user!) });
});

export const upload = handle(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new AppError('Send the file as the raw request body', 400);
  const name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).trim();
  // The browser sends the body as application/octet-stream and the real type in X-File-Type.
  const type = String(req.headers['x-file-type'] || 'application/octet-stream').split(';')[0]!.slice(0, 100);
  res.status(201).json(await service.addAttachment(req.params.id as string, name, type, req.body, req.user!));
});

// Only images and PDFs open inline; anything else downloads (stops uploaded HTML from running).
const INLINE = /^image\/(png|jpe?g|gif|webp)$|^application\/pdf$/;

export const download = handle(async (req, res) => {
  const { att, data } = await service.readAttachment(req.params.id as string, req.params.attachmentId as string);
  const inline = INLINE.test(att.mimeType);
  res.setHeader('Content-Type', inline ? att.mimeType : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.fileName)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(data);
});
