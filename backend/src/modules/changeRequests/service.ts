import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../config/logger';
import { AppError } from '../../utils/errors';
import type { JwtPayload } from '../../types';
import { OPEN_STATUSES, canApprove, findTransition, transitionsFor, approverRoles } from './workflow';
import type { CreateChangeDTO } from './validators';
import * as storage from './storage';
import { CHANGE_TYPES, LEVELS, PRIORITIES, PRODUCTS, RELEASE_TYPES } from './options';

const PERSON = { select: { id: true, name: true, email: true, role: true } } as const;

export interface ListFilters {
  status?: string;
  product?: string;
  q?: string;
  mine?: boolean;
  conflictsOnly?: boolean;
}

/** Cutover progress for linked Tilli-go projects: { projectId: { total, completed, blocked } } */
async function cutoverStats(projectIds: string[]) {
  if (projectIds.length === 0) return {} as Record<string, { total: number; completed: number; blocked: number }>;
  const rows = await prisma.task.groupBy({ by: ['projectId', 'status'], where: { projectId: { in: projectIds } }, _count: true });
  const out: Record<string, { total: number; completed: number; blocked: number }> = {};
  for (const r of rows) {
    const s = (out[r.projectId] ??= { total: 0, completed: 0, blocked: 0 });
    s.total += r._count;
    if (r.status === 'Completed') s.completed += r._count;
    if (r.status === 'Blocked') s.blocked += r._count;
  }
  return out;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export async function list(filters: ListFilters, user: JwtPayload) {
  const where: Prisma.ChangeRequestWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.product) where.product = filters.product;
  if (filters.mine) where.assigneeId = user.id;
  if (filters.q) {
    where.OR = [
      { title: { contains: filters.q, mode: 'insensitive' } },
      { description: { contains: filters.q, mode: 'insensitive' } },
      { customer: { contains: filters.q, mode: 'insensitive' } },
    ];
  }
  const rows = await prisma.changeRequest.findMany({
    where,
    include: { assignee: PERSON, project: { select: { id: true, code: true } } },
    orderBy: { plannedGoLive: 'asc' },
    take: 500,
  });

  // Conflicts are computed across ALL open CRs, not just the filtered page.
  const open = await prisma.changeRequest.findMany({
    where: { status: { in: OPEN_STATUSES } },
    select: { id: true, product: true, plannedGoLive: true },
  });
  const tally = new Map<string, number>();
  for (const c of open) tally.set(`${c.product}|${dayKey(c.plannedGoLive)}`, (tally.get(`${c.product}|${dayKey(c.plannedGoLive)}`) ?? 0) + 1);
  const openIds = new Set(open.map((c) => c.id));

  const stats = await cutoverStats(rows.flatMap((r) => (r.projectId ? [r.projectId] : [])));
  const data = rows
    .map((r) => ({
      ...r,
      hasConflict: openIds.has(r.id) && (tally.get(`${r.product}|${dayKey(r.plannedGoLive)}`) ?? 0) > 1,
      cutover: r.projectId ? stats[r.projectId] ?? { total: 0, completed: 0, blocked: 0 } : null,
    }))
    .filter((r) => !filters.conflictsOnly || r.hasConflict);

  const counts = await prisma.changeRequest.groupBy({ by: ['status'], _count: true });
  return { data, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
}

export async function findConflicts(product: string, date: Date, excludeId?: string) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  return prisma.changeRequest.findMany({
    where: {
      product,
      plannedGoLive: { gte: start, lt: end },
      status: { in: OPEN_STATUSES },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, number: true, title: true, status: true, assignee: { select: { name: true } } },
    orderBy: { number: 'asc' },
  });
}

export async function getById(id: string, user: JwtPayload) {
  const cr = await prisma.changeRequest.findUnique({
    where: { id },
    include: {
      assignee: PERSON,
      reporter: PERSON,
      approvedBy: PERSON,
      project: { select: { id: true, code: true, name: true } },
      events: { include: { actor: PERSON }, orderBy: { createdAt: 'desc' } },
      attachments: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!cr) throw new AppError('Change request not found', 404);
  const [conflicts, stats] = await Promise.all([
    ['CLOSED', 'CANCELLED'].includes(cr.status) ? [] : findConflicts(cr.product, cr.plannedGoLive, cr.id),
    cutoverStats(cr.projectId ? [cr.projectId] : []),
  ]);
  return {
    ...cr,
    conflicts,
    cutover: cr.projectId ? stats[cr.projectId] ?? { total: 0, completed: 0, blocked: 0 } : null,
    transitions: transitionsFor(cr.status),
    canApprove: canApprove(user.role),
  };
}

export async function create(dto: CreateChangeDTO, user: JwtPayload) {
  const people = await prisma.user.count({ where: { id: { in: [dto.assigneeId, dto.reporterId] } } });
  if (people < (dto.assigneeId === dto.reporterId ? 1 : 2)) throw new AppError('Assignee or reporter not found', 400);
  const cr = await prisma.changeRequest.create({
    data: {
      ...dto,
      events: { create: { kind: 'CREATED', toStatus: 'NEW', actorId: user.id, message: 'created the change request' } },
    },
  });
  logger.info({ crId: cr.id, number: cr.number }, 'Change request created');
  return cr;
}

export async function transition(id: string, to: string, reason: string | undefined, user: JwtPayload) {
  const cr = await prisma.changeRequest.findUnique({ where: { id } });
  if (!cr) throw new AppError('Change request not found', 404);
  const t = findTransition(cr.status, to);
  if (!t) throw new AppError(`Cannot move from ${cr.status} to ${to}`, 409);
  if (t.approverOnly && !canApprove(user.role)) {
    throw new AppError(`Approval is a gated checkpoint - only ${approverRoles().join('/')} users can approve`, 403);
  }
  if (t.needsReason && (!reason || reason.length < 5)) throw new AppError('Please give a short reason (5+ characters)', 400);

  // Gates tied to the cutover plan (the existing Tilli-go project).
  if (to === 'IMPLEMENT' && cr.needsCutover && !cr.projectId) {
    throw new AppError('Create the cutover plan before starting implementation', 409);
  }
  if (to === 'REVIEW' && cr.projectId) {
    const s = (await cutoverStats([cr.projectId]))[cr.projectId];
    if (s && s.completed < s.total) {
      throw new AppError(`Cutover not finished: ${s.completed}/${s.total} tasks completed`, 409);
    }
  }

  const approving = cr.status === 'ASSESS' && to === 'SCHEDULED';
  // Going back before "Scheduled" voids the approval - it must pass the gate again.
  const voidApproval = to === 'ASSESS' || to === 'NEW';

  const [updated] = await prisma.$transaction([
    prisma.changeRequest.update({
      where: { id },
      data: {
        status: to,
        ...(approving ? { approvedById: user.id, approvedAt: new Date() } : {}),
        ...(voidApproval ? { approvedById: null, approvedAt: null } : {}),
      },
    }),
    prisma.changeEvent.create({
      data: {
        changeRequestId: id,
        kind: 'STATUS',
        fromStatus: cr.status,
        toStatus: to,
        actorId: user.id,
        message: reason || (approving ? 'approved for production' : null),
      },
    }),
  ]);
  logger.info({ crId: id, from: cr.status, to, by: user.id }, 'Change request status changed');
  return updated;
}

export async function addComment(id: string, message: string, user: JwtPayload) {
  await ensureExists(id);
  return prisma.changeEvent.create({
    data: { changeRequestId: id, kind: 'COMMENT', actorId: user.id, message },
    include: { actor: PERSON },
  });
}

/** Creates the cutover plan as a normal Tilli-go project, linked to this CR. */
export async function createCutover(id: string, user: JwtPayload) {
  const cr = await prisma.changeRequest.findUnique({ where: { id } });
  if (!cr) throw new AppError('Change request not found', 404);
  if (cr.projectId) return prisma.project.findUniqueOrThrow({ where: { id: cr.projectId } });
  if (['CLOSED', 'CANCELLED'].includes(cr.status)) throw new AppError('This change request is finished', 409);

  let code = `CR-${cr.number}`;
  for (let i = 2; await prisma.project.findUnique({ where: { code } }); i++) code = `CR-${cr.number}-${i}`;

  const project = await prisma.$transaction(async (tx) => {
    const p = await tx.project.create({
      data: { code, name: `${code} ${cr.title}`.slice(0, 100), description: `Cutover plan for change request ${code}` },
    });
    await tx.changeRequest.update({ where: { id }, data: { projectId: p.id, needsCutover: true } });
    await tx.changeEvent.create({
      data: { changeRequestId: id, kind: 'CUTOVER', actorId: user.id, message: `created the cutover plan (project ${code})` },
    });
    return p;
  });
  logger.info({ crId: id, projectId: project.id }, 'Cutover project created for change request');
  return project;
}

const MAX_BYTES = 10 * 1024 * 1024;

export async function addAttachment(id: string, fileName: string, mimeType: string, data: Buffer, user: JwtPayload) {
  const cr = await prisma.changeRequest.findUnique({ where: { id } });
  if (!cr) throw new AppError('Change request not found', 404);
  if (!fileName || data.length === 0) throw new AppError('Empty file', 400);
  if (data.length > MAX_BYTES) throw new AppError('File is larger than 10 MB', 413);
  const key = await storage.saveFile(cr.number, fileName, data);
  const [att] = await prisma.$transaction([
    prisma.changeAttachment.create({
      data: { changeRequestId: id, fileName: fileName.slice(0, 200), mimeType, size: data.length, provider: storage.providerName, storageKey: key, uploadedById: user.id },
    }),
    prisma.changeEvent.create({ data: { changeRequestId: id, kind: 'ATTACHMENT', actorId: user.id, message: `attached ${fileName.slice(0, 200)}` } }),
  ]);
  return att;
}

export async function readAttachment(crId: string, attachmentId: string) {
  const att = await prisma.changeAttachment.findFirst({ where: { id: attachmentId, changeRequestId: crId } });
  if (!att) throw new AppError('Attachment not found', 404);
  return { att, data: await storage.readStoredFile(att.storageKey) };
}

export async function meta(user: JwtPayload) {
  const users = await prisma.user.findMany({ ...PERSON, orderBy: { name: 'asc' } });
  return {
    users,
    options: { products: PRODUCTS, changeTypes: CHANGE_TYPES, releaseTypes: RELEASE_TYPES, priorities: PRIORITIES, levels: LEVELS },
    approverRoles: approverRoles(),
    canApprove: canApprove(user.role),
  };
}

async function ensureExists(id: string) {
  const found = await prisma.changeRequest.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw new AppError('Change request not found', 404);
}
