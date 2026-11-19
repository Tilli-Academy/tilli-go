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
  // ?products=id1,id2&date=YYYY-MM-DD (the go-live day in the CR's project zone)
  const products = (str(req.query.products) ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const day = str(req.query.date) ?? '';
  if (products.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    res.json({ conflicts: [] });
    return;
  }
  res.json({ conflicts: await service.findConflicts(products, day, str(req.query.exclude)) });
});

export const getById = handle(async (req, res) => {
  res.json(await service.getById(req.params.id as string, req.user!));
});

export const create = handle(async (req, res) => {
  res.status(201).json(await service.create(req.body, req.user!));
});

export const update = handle(async (req, res) => {
  res.json(await service.update(req.params.id as string, req.body, req.user!));
});

export const decide = handle(async (req, res) => {
  res.json(await service.decide(req.params.id as string, req.body.decision, req.body.reason, req.body.datePresented, req.user!));
});

export const setDocument = handle(async (req, res) => {
  await service.setDocument(req.params.id as string, req.params.typeId as string, req.body, req.user!);
  res.status(204).end();
});

export const removeDocument = handle(async (req, res) => {
  await service.removeDocument(req.params.id as string, req.params.typeId as string, req.user!);
  res.status(204).end();
});

export const addLink = handle(async (req, res) => {
  await service.addLink(req.params.id as string, req.body.number, req.user!);
  res.status(204).end();
});

export const removeLink = handle(async (req, res) => {
  await service.removeLink(req.params.id as string, req.params.otherId as string, req.user!);
  res.status(204).end();
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
  // The type is worked out from the file itself (service → checkUpload), not from a header.
  res.status(201).json(await service.addAttachment(req.params.id as string, name, req.body, req.user!));
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
