import type { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../config/logger';
import { checkUpload } from '../../utils/fileType';
import { AppError } from '../../utils/errors';
import type { JwtPayload } from '../../types';
import { DECISIONS, FINISHED, OPEN_STATUSES, findTransition, transitionsFor, type Decision } from './workflow';
import { assertPermission, hasPermission, permissionsFor, rolesWith } from '../auth/permissions';
import { assertValues } from '../lists/service';
import type { CreateChangeDTO, UpdateChangeDTO } from './validators';
import * as storage from './storage';
import { isDone } from '../../types';
import { DEFAULT_TIME_ZONE, dayKeyIn } from '../../utils/zoneTime';

const PERSON = { select: { id: true, name: true, email: true, role: true } } as const;
const VALUE = { select: { id: true, label: true, color: true, active: true } } as const;

/** List values as plain objects on the CR (changeType, releaseType, priority, team, products). */
const LIST_INCLUDE = {
  changeTypeRef: VALUE,
  releaseTypeRef: VALUE,
  priorityRef: VALUE,
  team: VALUE,
  products: { select: { product: VALUE } },
} as const;

type WithLists = Prisma.ChangeRequestGetPayload<{ include: typeof LIST_INCLUDE }>;

function shape<T extends WithLists>(r: T) {
  const { changeTypeRef, releaseTypeRef, priorityRef, products, product: _p, changeType: _c, releaseType: _r, priority: _pr, ...rest } = r;
  return {
    ...rest,
    changeType: changeTypeRef,
    releaseType: releaseTypeRef,
    priority: priorityRef,
    products: products.map((p) => p.product),
  };
}

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
    if (isDone(r.status)) s.completed += r._count; // Completed or N/A
    if (r.status === 'Blocked') s.blocked += r._count;
  }
  return out;
}

/** The go-live calendar day, in the CR's project zone (default US Central). */
const goLiveDay = (d: Date, tz: string | null | undefined) => dayKeyIn(d, tz ?? DEFAULT_TIME_ZONE);
const DAY_MS = 86_400_000;

/** Progress of the tasks tagged with this CR; null when it has none. */
async function ownTaskStats(crId: string) {
  const rows = await prisma.task.groupBy({ by: ['status'], where: { changeRequestId: crId }, _count: true });
  if (rows.length === 0) return null;
  const s = { total: 0, completed: 0, blocked: 0 };
  for (const r of rows) {
    s.total += r._count;
    if (isDone(r.status)) s.completed += r._count;
    if (r.status === 'Blocked') s.blocked += r._count;
  }
  return s;
}

/** Assignee, reporter, or an approver (until the Roles page exists). */
function isOwnerOrApprover(cr: { assigneeId: string; reporterId: string }, user: JwtPayload, permissions: string[]): boolean {
  return cr.assigneeId === user.id || cr.reporterId === user.id || permissions.includes('cr.decide');
}

export async function list(filters: ListFilters, user: JwtPayload) {
  const where: Prisma.ChangeRequestWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.product) where.products = { some: { productId: filters.product } };
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
    include: { ...LIST_INCLUDE, assignee: PERSON, project: { select: { id: true, code: true, timeZone: true } } },
    orderBy: { plannedGoLive: 'asc' },
    take: 500,
  });

  // Same-day conflicts: open CRs sharing at least one product on the same go-live day.
  // Computed across ALL open CRs, not just the filtered page.
  const open = await prisma.changeRequest.findMany({
    where: { status: { in: OPEN_STATUSES } },
    select: { id: true, plannedGoLive: true, products: { select: { productId: true } }, project: { select: { timeZone: true } } },
  });
  const tally = new Map<string, number>();
  for (const c of open) {
    const day = goLiveDay(c.plannedGoLive, c.project?.timeZone);
    for (const p of c.products) tally.set(`${p.productId}|${day}`, (tally.get(`${p.productId}|${day}`) ?? 0) + 1);
  }
  const openIds = new Set(open.map((c) => c.id));

  const stats = await cutoverStats(rows.flatMap((r) => (r.projectId ? [r.projectId] : [])));
  const data = rows
    .map((r) => ({
      ...shape(r),
      hasConflict: openIds.has(r.id) && r.products.some((p) => (tally.get(`${p.product.id}|${goLiveDay(r.plannedGoLive, r.project?.timeZone)}`) ?? 0) > 1),
      cutover: r.projectId ? stats[r.projectId] ?? { total: 0, completed: 0, blocked: 0 } : null,
    }))
    .filter((r) => !filters.conflictsOnly || r.hasConflict);

  const counts = await prisma.changeRequest.groupBy({ by: ['status'], _count: true });
  return { data, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) };
}

/**
 * Open CRs that share at least one of these products and go live on the same calendar
 * day. `day` is "YYYY-MM-DD"; each CR's go-live is read in its own project's zone.
 */
export async function findConflicts(productIds: string[], day: string, excludeId?: string) {
  if (productIds.length === 0) return [];
  const noon = new Date(`${day}T12:00:00.000Z`);
  const rows = await prisma.changeRequest.findMany({
    where: {
      products: { some: { productId: { in: productIds } } },
      // a generous window; the exact day is checked below in each CR's zone
      plannedGoLive: { gte: new Date(noon.getTime() - 2 * DAY_MS), lt: new Date(noon.getTime() + 2 * DAY_MS) },
      status: { in: OPEN_STATUSES },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: {
      id: true, number: true, title: true, status: true, plannedGoLive: true,
      assignee: { select: { name: true } }, project: { select: { timeZone: true } },
    },
    orderBy: { number: 'asc' },
  });
  return rows
    .filter((c) => goLiveDay(c.plannedGoLive, c.project?.timeZone) === day)
    .map(({ plannedGoLive: _g, project: _p, ...c }) => c);
}

export async function getById(id: string, user: JwtPayload) {
  const cr = await prisma.changeRequest.findUnique({
    where: { id },
    include: {
      ...LIST_INCLUDE,
      assignee: PERSON,
      reporter: PERSON,
      approvedBy: PERSON,
      decidedBy: PERSON,
      project: {
        select: {
          id: true, code: true, name: true, timeZone: true,
          changeRequests: { select: { id: true, number: true, title: true, status: true }, orderBy: { number: 'asc' } },
        },
      },
      events: { include: { actor: PERSON }, orderBy: { createdAt: 'desc' } },
      attachments: { orderBy: { createdAt: 'desc' } },
      documents: { select: { documentTypeId: true, attachmentId: true, url: true, createdAt: true, attachment: { select: { id: true, fileName: true } } } },
      linksFrom: { select: { to: { select: { id: true, number: true, title: true, status: true } } } },
      linksTo: { select: { from: { select: { id: true, number: true, title: true, status: true } } } },
    },
  });
  if (!cr) throw new AppError('Change request not found', 404);
  const [conflicts, stats, permissions, own] = await Promise.all([
    FINISHED.includes(cr.status) ? [] : findConflicts(cr.products.map((p) => p.product.id), goLiveDay(cr.plannedGoLive, cr.project?.timeZone), cr.id),
    cutoverStats(cr.projectId ? [cr.projectId] : []),
    permissionsFor(user),
    ownTaskStats(cr.id),
  ]);
  const { linksFrom, linksTo, ...rest } = cr;
  const can = (p: string) => (permissions as string[]).includes(p);
  return {
    ...shape(rest as typeof cr),
    linked: [...linksFrom.map((l) => l.to), ...linksTo.map((l) => l.from)].sort((a, b) => a.number - b.number),
    conflicts,
    cutover: cr.projectId ? stats[cr.projectId] ?? { total: 0, completed: 0, blocked: 0 } : null,
    /** Tasks tagged with this CR (null when none are tagged: the whole project counts). */
    ownTasks: own,
    transitions: transitionsFor(cr.status).map((t) => ({ ...t, allowed: can(t.permission) && (!t.ownersOnly || isOwnerOrApprover(cr, user, permissions)) })),
    canDecide: cr.status === 'ASSESS' && can('cr.decide'),
    permissions,
  };
}

export async function create(dto: CreateChangeDTO, user: JwtPayload) {
  const people = await prisma.user.count({ where: { id: { in: [dto.assigneeId, dto.reporterId] } } });
  if (people < (dto.assigneeId === dto.reporterId ? 1 : 2)) throw new AppError('Assignee or reporter not found', 400);
  if (dto.projectId && !(await prisma.project.findUnique({ where: { id: dto.projectId }, select: { id: true } }))) {
    throw new AppError('Project not found', 400);
  }
  await checkListValues(dto);
  const { productIds, ...data } = dto;
  const cr = await prisma.changeRequest.create({
    data: {
      ...data,
      products: { create: [...new Set(productIds)].map((productId) => ({ productId })) },
      events: { create: { kind: 'CREATED', toStatus: 'NEW', actorId: user.id, message: 'created the change request' } },
    },
  });
  logger.info({ crId: cr.id, number: cr.number }, 'Change request created');
  return cr;
}

/** New choices must be active values of the right list; a CR may keep an old (inactive) one. */
async function checkListValues(dto: Partial<UpdateChangeDTO>, current?: WithLists) {
  const keep = current
    ? [current.changeTypeId, current.releaseTypeId, current.priorityId, current.teamId, ...current.products.map((p) => p.product.id)].filter(
        (x): x is string => !!x,
      )
    : [];
  await assertValues('change_type', dto.changeTypeId ? [dto.changeTypeId] : [], keep);
  await assertValues('release_type', dto.releaseTypeId ? [dto.releaseTypeId] : [], keep);
  await assertValues('priority', dto.priorityId ? [dto.priorityId] : [], keep);
  await assertValues('team', dto.teamId ? [dto.teamId] : [], keep);
  await assertValues('product', dto.productIds ?? [], keep);
}

const LABELS: Record<string, string> = {
  title: 'title', description: 'description', changeTypeId: 'change type', releaseTypeId: 'release type', priorityId: 'priority',
  teamId: 'team', productIds: 'products', risk: 'risk', impact: 'impact', customer: 'customer', labels: 'labels',
  plannedGoLive: 'deployment date', dueDate: 'due date', datePresented: 'date presented', codeFreezeDate: 'code freeze date',
  downtimeHours: 'downtime', needsCutover: 'cutover needed', assigneeId: 'assignee',
};

export async function update(id: string, dto: UpdateChangeDTO, user: JwtPayload) {
  const cr = await prisma.changeRequest.findUnique({ where: { id }, include: LIST_INCLUDE });
  if (!cr) throw new AppError('Change request not found', 404);
  if (FINISHED.includes(cr.status)) throw new AppError('This change request is finished', 409);
  // The go-live date is what CAB approved: after approval it changes only by sending the CR back.
  if (dto.plannedGoLive && dto.plannedGoLive.getTime() !== cr.plannedGoLive.getTime() && !['NEW', 'ASSESS'].includes(cr.status)) {
    throw new AppError('The deployment date is locked once approved - send the change back to change it', 409);
  }
  if (dto.assigneeId && !(await prisma.user.findUnique({ where: { id: dto.assigneeId }, select: { id: true } }))) {
    throw new AppError('Assignee not found', 400);
  }
  await checkListValues(dto, cr);

  const { productIds, ...fields } = dto;
  const before = cr as unknown as Record<string, unknown>;
  const changed = Object.entries(fields)
    .filter(([k, v]) => {
      const old = before[k];
      if (v instanceof Date) return !(old instanceof Date) || old.getTime() !== v.getTime();
      if (Array.isArray(v)) return JSON.stringify(v) !== JSON.stringify(old);
      return v !== old;
    })
    .map(([k]) => k);
  const oldProducts = cr.products.map((p) => p.product.id).sort();
  const newProducts = productIds ? [...new Set(productIds)].sort() : oldProducts;
  const productsChanged = JSON.stringify(oldProducts) !== JSON.stringify(newProducts);
  if (productsChanged) changed.push('productIds');
  if (changed.length === 0) return cr;

  await prisma.$transaction(async (tx) => {
    // Saved only if the status is still the one checked above (finished / date lock).
    const saved = await tx.changeRequest.updateMany({ where: { id, status: cr.status }, data: fields });
    if (saved.count === 0) throw changedMeanwhile();
    if (productsChanged) {
      await tx.changeProduct.deleteMany({ where: { changeRequestId: id } });
      await tx.changeProduct.createMany({ data: newProducts.map((productId) => ({ changeRequestId: id, productId })) });
    }
    await tx.changeEvent.create({
      data: { changeRequestId: id, kind: 'EDIT', actorId: user.id, message: `changed ${changed.map((k) => LABELS[k] ?? k).join(', ')}` },
    });
  });
  logger.info({ crId: id, fields: changed }, 'Change request edited');
  return prisma.changeRequest.findUniqueOrThrow({ where: { id } });
}

export async function transition(id: string, to: string, reason: string | undefined, user: JwtPayload) {
  const cr = await prisma.changeRequest.findUnique({ where: { id } });
  if (!cr) throw new AppError('Change request not found', 404);
  if (cr.status === 'ASSESS' && to !== 'CANCELLED') {
    throw new AppError('Leaving Assess is a CAB decision: Approve, Request more info, Defer or Reject', 409);
  }
  const t = findTransition(cr.status, to);
  if (!t) throw new AppError(`Cannot move from ${cr.status} to ${to}`, 409);
  await assertPermission(user, t.permission);
  if (t.ownersOnly && !isOwnerOrApprover(cr, user, await permissionsFor(user))) {
    throw new AppError("Only the change's assignee, its reporter or an approver can send it back to Assess", 403);
  }
  if (t.needsReason && (!reason || reason.length < 5)) throw new AppError('Please give a short reason (5+ characters)', 400);

  // Gates tied to the project's cutover plan.
  // Implement needs a plan: a project with at least one task.
  if (to === 'IMPLEMENT' && cr.needsCutover) {
    if (!cr.projectId) throw new AppError('Pick or create the project before starting implementation', 409);
    const tasks = await prisma.task.count({ where: { projectId: cr.projectId } });
    if (tasks === 0) throw new AppError("The project's cutover plan has no tasks yet", 409);
  }
  // Review waits for the CR's own (tagged) tasks if it has any, else the whole project's plan.
  if (to === 'REVIEW' && cr.projectId) {
    const own = await ownTaskStats(cr.id);
    const s = own ?? (await cutoverStats([cr.projectId]))[cr.projectId];
    if (s && s.completed < s.total) {
      throw new AppError(`${own ? "This change's tasks" : 'Project cutover'} not finished: ${s.completed}/${s.total} done`, 409);
    }
  }

  // Going back to Assess voids the approval - it must pass CAB again.
  const voidApproval = to === 'ASSESS';
  // One conditional update: only if the CR is still where we checked it, so two moves
  // at the same moment can't both apply (the second gets 409 and nothing is saved).
  const updated = await prisma.$transaction(async (tx) => {
    const moved = await tx.changeRequest.updateMany({
      where: { id, status: cr.status },
      data: { status: to, ...(voidApproval ? { approvedById: null, approvedAt: null, decision: null, decidedAt: null, decidedById: null } : {}) },
    });
    if (moved.count === 0) throw changedMeanwhile();
    await tx.changeEvent.create({
      data: { changeRequestId: id, kind: 'STATUS', fromStatus: cr.status, toStatus: to, actorId: user.id, message: reason || null },
    });
    return tx.changeRequest.findUniqueOrThrow({ where: { id } });
  });
  logger.info({ crId: id, from: cr.status, to, by: user.id }, 'Change request status changed');
  return updated;
}

/** CAB decision on a CR in Assess (cr.decide only). */
export async function decide(id: string, decision: Decision, reason: string | undefined, datePresented: Date | undefined, user: JwtPayload) {
  await assertPermission(user, 'cr.decide', 'Only approvers can make a CAB decision');
  const cr = await prisma.changeRequest.findUnique({ where: { id } });
  if (!cr) throw new AppError('Change request not found', 404);
  if (cr.status !== 'ASSESS') throw new AppError('Decisions are made while the change is in Assess', 409);
  const rule = DECISIONS[decision];
  if (rule.needsReason && (!reason || reason.length < 5)) throw new AppError('Please give a short reason (5+ characters)', 400);

  if (decision === 'DEFERRED') {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const floor = cr.datePresented && cr.datePresented > today ? cr.datePresented : today;
    if (!datePresented || datePresented <= floor) throw new AppError('Deferred needs a later CAB date (Date Presented)', 400);
  }
  if (decision === 'APPROVED') {
    const missing = await missingRequiredDocuments(id);
    if (missing.length) throw new AppError(`Attach the required documents first: ${missing.join(', ')}`, 409);
  }

  const now = new Date();
  const label = (await prisma.listValue.findUnique({ where: { list_key: { list: 'decision', key: decision } } }))?.label ?? decision;
  // One conditional update: only while still in Assess. Two approvers deciding at the
  // same moment can't overwrite each other; the second gets 409.
  const updated = await prisma.$transaction(async (tx) => {
    const decided = await tx.changeRequest.updateMany({
      where: { id, status: 'ASSESS', updatedAt: cr.updatedAt },
      data: {
        status: rule.to,
        decision,
        decidedAt: now,
        decidedById: user.id,
        ...(decision === 'APPROVED' ? { approvedById: user.id, approvedAt: now } : { approvedById: null, approvedAt: null }),
        ...(decision === 'DEFERRED' ? { datePresented } : {}),
      },
    });
    if (decided.count === 0) throw changedMeanwhile();
    await tx.changeEvent.create({
      data: {
        changeRequestId: id,
        kind: rule.to === cr.status ? 'DECISION' : 'STATUS',
        fromStatus: cr.status,
        toStatus: rule.to === cr.status ? null : rule.to,
        actorId: user.id,
        message: [label, decision === 'DEFERRED' ? `to CAB on ${datePresented!.toISOString().slice(0, 10)}` : null, reason].filter(Boolean).join(' - '),
      },
    });
    return tx.changeRequest.findUniqueOrThrow({ where: { id } });
  });
  logger.info({ crId: id, decision, by: user.id }, 'CAB decision');
  return updated;
}

async function missingRequiredDocuments(id: string): Promise<string[]> {
  const [required, docs] = await Promise.all([
    prisma.listValue.findMany({ where: { list: 'supporting_document', active: true, required: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.changeDocument.findMany({ where: { changeRequestId: id }, select: { documentTypeId: true, attachmentId: true, url: true } }),
  ]);
  const have = new Set(docs.filter((d) => d.attachmentId || d.url).map((d) => d.documentTypeId));
  return required.filter((r) => !have.has(r.id)).map((r) => r.label);
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
 * optional cutover: its task plan. A CR picks an existing project (cr.edit), creates a
 * new one (also needs project.manage) or, before implementation, leaves its project.
 * The CR row is locked so two clicks can't create two projects.
 */
export async function setProject(id: string, choice: ProjectChoice, user: JwtPayload) {
  if ('create' in choice) await assertPermission(user, 'project.manage', 'Only project managers can create projects');
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
    // Tasks tagged with this CR stay in the old project's plan: they lose the tag.
    await tx.task.updateMany({ where: { changeRequestId: id, ...(project ? { projectId: { not: project.id } } : {}) }, data: { changeRequestId: null } });
    const message = project
      ? `${'create' in choice ? 'created and linked' : cr.projectId ? 'moved to' : 'linked to'} project ${project.code}${cr.project ? ` (was ${cr.project.code})` : ''}`
      : `removed from project ${cr.project?.code ?? ''}`;
    await tx.changeEvent.create({ data: { changeRequestId: id, kind: 'CUTOVER', actorId: user.id, message } });
    return { changed: true, project };
  });
  if (result.changed) logger.info({ crId: id, projectId: result.project?.id ?? null }, 'Change request project changed');
  return result.project;
}

// ── Supporting documents ────────────────────────────────────────────────────

export async function setDocument(id: string, documentTypeId: string, body: { attachmentId: string } | { url: string }, user: JwtPayload) {
  const cr = await editable(id);
  const type = await prisma.listValue.findUnique({ where: { id: documentTypeId } });
  if (!type || type.list !== 'supporting_document') throw new AppError('Unknown document type', 404);
  if ('attachmentId' in body) {
    const att = await prisma.changeAttachment.findFirst({ where: { id: body.attachmentId, changeRequestId: id } });
    if (!att) throw new AppError('Attachment not found on this change request', 400);
  }
  const data = 'attachmentId' in body ? { attachmentId: body.attachmentId, url: null } : { url: body.url, attachmentId: null };
  await prisma.$transaction([
    prisma.changeDocument.upsert({
      where: { changeRequestId_documentTypeId: { changeRequestId: id, documentTypeId } },
      create: { changeRequestId: id, documentTypeId, addedById: user.id, ...data },
      update: { ...data, addedById: user.id },
    }),
    prisma.changeEvent.create({ data: { changeRequestId: cr.id, kind: 'DOCUMENT', actorId: user.id, message: `added ${type.label}` } }),
  ]);
}

export async function removeDocument(id: string, documentTypeId: string, user: JwtPayload) {
  await editable(id);
  const doc = await prisma.changeDocument.findUnique({
    where: { changeRequestId_documentTypeId: { changeRequestId: id, documentTypeId } },
    include: { documentType: { select: { label: true } } },
  });
  if (!doc) return;
  await prisma.$transaction([
    prisma.changeDocument.delete({ where: { id: doc.id } }),
    prisma.changeEvent.create({ data: { changeRequestId: id, kind: 'DOCUMENT', actorId: user.id, message: `removed ${doc.documentType.label}` } }),
  ]);
}

// ── Linked change requests ──────────────────────────────────────────────────

export async function addLink(id: string, number: number, user: JwtPayload) {
  const cr = await editable(id);
  const other = await prisma.changeRequest.findUnique({ where: { number }, select: { id: true, number: true } });
  if (!other) throw new AppError(`CR-${number} not found`, 404);
  if (other.id === id) throw new AppError('A change request cannot link to itself', 400);
  const exists = await prisma.changeLink.findFirst({ where: { OR: [{ fromId: id, toId: other.id }, { fromId: other.id, toId: id }] } });
  if (exists) return;
  await prisma.$transaction([
    prisma.changeLink.create({ data: { fromId: id, toId: other.id } }),
    prisma.changeEvent.create({ data: { changeRequestId: id, kind: 'LINK', actorId: user.id, message: `linked CR-${other.number}` } }),
    prisma.changeEvent.create({ data: { changeRequestId: other.id, kind: 'LINK', actorId: user.id, message: `linked CR-${cr.number}` } }),
  ]);
}

export async function removeLink(id: string, otherId: string, user: JwtPayload) {
  const cr = await editable(id);
  const other = await prisma.changeRequest.findUnique({ where: { id: otherId }, select: { id: true, number: true } });
  const { count } = await prisma.changeLink.deleteMany({ where: { OR: [{ fromId: id, toId: otherId }, { fromId: otherId, toId: id }] } });
  if (count && other) {
    await prisma.changeEvent.createMany({
      data: [
        { changeRequestId: id, kind: 'LINK', actorId: user.id, message: `unlinked CR-${other.number}` },
        { changeRequestId: other.id, kind: 'LINK', actorId: user.id, message: `unlinked CR-${cr.number}` },
      ],
    });
  }
}

async function editable(id: string) {
  const cr = await prisma.changeRequest.findUnique({ where: { id }, select: { id: true, number: true, status: true } });
  if (!cr) throw new AppError('Change request not found', 404);
  if (FINISHED.includes(cr.status)) throw new AppError('This change request is finished', 409);
  return cr;
}

// ── Attachments ─────────────────────────────────────────────────────────────

const MAX_BYTES = 10 * 1024 * 1024;

export async function addAttachment(id: string, fileName: string, data: Buffer, user: JwtPayload) {
  const cr = await editable(id); // not on a closed / cancelled change
  if (!fileName || data.length === 0) throw new AppError('Empty file', 400);
  if (data.length > MAX_BYTES) throw new AppError('File is larger than 10 MB', 413);
  // Allowed types only; the stored type comes from the file itself, not the browser.
  const mimeType = checkUpload(fileName, data);
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
  const [users, permissions, approverRoles] = await Promise.all([
    prisma.user.findMany({ ...PERSON, orderBy: { name: 'asc' } }),
    permissionsFor(user),
    rolesWith('cr.decide'),
  ]);
  return { users, permissions, approverRoles, canApprove: await hasPermission(user, 'cr.decide') };
}

/** Someone else moved or decided the CR between our read and our save. */
const changedMeanwhile = () =>
  new AppError('This change request was just updated by someone else - reload it and try again', 409);

async function ensureExists(id: string) {
  const found = await prisma.changeRequest.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw new AppError('Change request not found', 404);
}
