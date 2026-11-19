import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../config/logger';
import { AppError } from '../../utils/errors';
import type { JwtPayload } from '../../types';
import { OPEN_STATUSES, findTransition, transitionsFor } from './workflow';
import { hasPermission, rolesWith } from '../auth/permissions';
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
  projectId?: string;
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
  if (filters.projectId) where.projectId = filters.projectId;
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
      project: {
        select: {
          id: true, code: true, name: true, timeZone: true,
          changeRequests: { select: { id: true, number: true, title: true, status: true }, orderBy: { number: 'asc' } },
        },
      },
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
    canApprove: hasPermission(user, 'cr.decide'),
  };
}

export async function create(dto: CreateChangeDTO, user: JwtPayload) {
  const people = await prisma.user.count({ where: { id: { in: [dto.assigneeId, dto.reporterId] } } });
  if (people < (dto.assigneeId === dto.reporterId ? 1 : 2)) throw new AppError('Assignee or reporter not found', 400);
  if (dto.projectId && !(await prisma.project.findUnique({ where: { id: dto.projectId }, select: { id: true } }))) {
    throw new AppError('Project not found', 400);
  }
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
  if (t.approverOnly && !hasPermission(user, 'cr.decide')) {
    throw new AppError('Only approvers can approve, send back or reject a change request', 403);
  }
  if (t.needsReason && (!reason || reason.length < 5)) throw new AppError('Please give a short reason (5+ characters)', 400);

  // Gates tied to the cutover plan (the existing Tilli-go project).
  // Implement needs a plan: a project with at least one task.
  if (to === 'IMPLEMENT' && cr.needsCutover) {
    if (!cr.projectId) throw new AppError('Pick or create the project before starting implementation', 409);
    const tasks = await prisma.task.count({ where: { projectId: cr.projectId } });
    if (tasks === 0) throw new AppError("The project's cutover plan has no tasks yet", 409);
  }
  if (to === 'REVIEW' && cr.projectId) {
    const s = (await cutoverStats([cr.projectId]))[cr.projectId];
    if (s && s.completed < s.total) {
      throw new AppError(`Project cutover not finished: ${s.completed}/${s.total} tasks completed`, 409);
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

/** A CR can change project until implementation starts; after that its plan is fixed. */
const PROJECT_LOCKED: string[] = ['IMPLEMENT', 'REVIEW', 'CLOSED', 'CANCELLED'];

export type ProjectChoice =
  | { projectId: string | null }
  | { create: { name: string; code: string; timeZone?: string; description?: string } };

/**
 * A project groups one or more change requests (e.g. a release wave) and owns the
 * optional cutover: its task plan. A CR picks an existing project, creates a new one,
 * or (before implementation) leaves its project. The CR row is locked so two clicks
 * can't create two projects.
 */
export async function setProject(id: string, choice: ProjectChoice, user: JwtPayload) {
  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "change_requests" WHERE id = ${id} FOR UPDATE`;
    if (locked.length === 0) throw new AppError('Change request not found', 404);
    const cr = await tx.changeRequest.findUniqueOrThrow({ where: { id }, include: { project: { select: { code: true } } } });
    if (PROJECT_LOCKED.includes(cr.status)) {
      throw new AppError('The project can only be changed before implementation starts', 409);
    }

    let project: { id: string; code: string } | null = null;
    if ('create' in choice) {
      if (await tx.project.findUnique({ where: { code: choice.create.code } })) throw new AppError('Project code already exists', 409);
      project = await tx.project.create({ data: choice.create, select: { id: true, code: true } });
    } else if (choice.projectId) {
      project = await tx.project.findUnique({ where: { id: choice.projectId }, select: { id: true, code: true } });
      if (!project) throw new AppError('Project not found', 404);
    }
    if ((project?.id ?? null) === cr.projectId) return { changed: false, project };

    await tx.changeRequest.update({ where: { id }, data: { projectId: project?.id ?? null } });
    const message = project
      ? `${'create' in choice ? 'created and linked' : cr.projectId ? 'moved to' : 'linked to'} project ${project.code}${cr.project ? ` (was ${cr.project.code})` : ''}`
      : `removed from project ${cr.project?.code ?? ''}`;
    await tx.changeEvent.create({ data: { changeRequestId: id, kind: 'CUTOVER', actorId: user.id, message } });
    return { changed: true, project };
  });
  if (result.changed) logger.info({ crId: id, projectId: result.project?.id ?? null }, 'Change request project changed');
  return result.project;
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
    approverRoles: rolesWith('cr.decide'),
    canApprove: hasPermission(user, 'cr.decide'),
  };
}

async function ensureExists(id: string) {
  const found = await prisma.changeRequest.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw new AppError('Change request not found', 404);
}
