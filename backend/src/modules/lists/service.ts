import type { Prisma, ListValue } from '@prisma/client';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/errors';

// Admin-managed dropdown lists. Values are rows with stable ids, so renaming or
// recolouring a value never touches the change requests that use it.
export const LISTS = {
  change_type: { label: 'Change type', fixed: false },
  release_type: { label: 'Release type', fixed: false },
  product: { label: 'Products', fixed: false },
  priority: { label: 'Priority', fixed: false },
  team: { label: 'Team', fixed: false },
  supporting_document: { label: 'Supporting documents', fixed: false },
  // Keys drive rules, so only labels and colours can change.
  risk: { label: 'Risk', fixed: true },
  decision: { label: 'Decision', fixed: true },
} as const;
export type ListName = keyof typeof LISTS;

export const isListName = (s: string): s is ListName => Object.prototype.hasOwnProperty.call(LISTS, s);

const ORDER: Prisma.ListValueOrderByWithRelationInput[] = [{ sortOrder: 'asc' }, { label: 'asc' }];

/** All lists. Pickers get active values only; Admin → Lists gets everything plus usage counts. */
export async function all(includeInactive: boolean) {
  const rows = await prisma.listValue.findMany({ where: includeInactive ? {} : { active: true }, orderBy: ORDER });
  const usage = includeInactive ? await usageCounts() : null;
  const out = Object.fromEntries(Object.keys(LISTS).map((k) => [k, [] as Array<ListValue & { inUse?: number }>])) as Record<
    ListName,
    Array<ListValue & { inUse?: number }>
  >;
  for (const r of rows) if (isListName(r.list)) out[r.list].push(usage ? { ...r, inUse: usage.get(r.id) ?? 0 } : r);
  return out;
}

async function usageCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const add = (id: string | null, n: number) => id && counts.set(id, (counts.get(id) ?? 0) + n);
  for (const field of ['changeTypeId', 'releaseTypeId', 'priorityId', 'teamId'] as const) {
    const rows = await prisma.changeRequest.groupBy({ by: [field], _count: true });
    for (const r of rows) add(r[field], r._count);
  }
  for (const r of await prisma.changeProduct.groupBy({ by: ['productId'], _count: true })) add(r.productId, r._count);
  for (const r of await prisma.changeDocument.groupBy({ by: ['documentTypeId'], _count: true })) add(r.documentTypeId, r._count);
  return counts;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export async function add(list: string, data: { label: string; color?: string | null; required?: boolean }) {
  if (!isListName(list)) throw new AppError('Unknown list', 404);
  if (LISTS[list].fixed) throw new AppError(`${LISTS[list].label} has fixed values; only labels and colours can change`, 409);
  await assertUniqueLabel(list, data.label);
  const last = await prisma.listValue.aggregate({ where: { list }, _max: { sortOrder: true } });
  return prisma.listValue.create({
    data: {
      list,
      label: data.label,
      color: data.color ?? null,
      required: list === 'supporting_document' ? !!data.required : false,
      sortOrder: (last._max.sortOrder ?? 0) + 1,
    },
  });
}

export async function update(id: string, data: { label?: string; color?: string | null; active?: boolean; required?: boolean }) {
  const value = await prisma.listValue.findUnique({ where: { id } });
  if (!value || !isListName(value.list)) throw new AppError('Value not found', 404);
  const fixed = LISTS[value.list].fixed;
  if (fixed && data.active !== undefined) throw new AppError('Fixed values cannot be deactivated', 409);
  if (data.required !== undefined && value.list !== 'supporting_document') throw new AppError('Only supporting documents can be required', 400);
  if (data.label && data.label !== value.label) await assertUniqueLabel(value.list, data.label, id);
  return prisma.listValue.update({ where: { id }, data });
}

/** New order for one list: ids in the order they should appear. */
export async function reorder(list: string, ids: string[]) {
  if (!isListName(list)) throw new AppError('Unknown list', 404);
  const values = await prisma.listValue.findMany({ where: { list }, select: { id: true } });
  const known = new Set(values.map((v) => v.id));
  if (ids.length !== known.size || !ids.every((id) => known.has(id))) throw new AppError('Send every value of the list exactly once', 400);
  await prisma.$transaction(ids.map((id, i) => prisma.listValue.update({ where: { id }, data: { sortOrder: i + 1 } })));
  return all(true).then((lists) => lists[list]);
}

/** Only values nobody uses can be removed; values in use are deactivated instead. */
export async function remove(id: string) {
  const value = await prisma.listValue.findUnique({ where: { id } });
  if (!value || !isListName(value.list)) throw new AppError('Value not found', 404);
  if (LISTS[value.list].fixed) throw new AppError('Fixed values cannot be removed', 409);
  const used = (await usageCounts()).get(id) ?? 0;
  if (used > 0) throw new AppError(`Used by ${used} change request(s) - deactivate it instead`, 409);
  await prisma.listValue.delete({ where: { id } });
}

async function assertUniqueLabel(list: string, label: string, exceptId?: string) {
  const clash = await prisma.listValue.findFirst({
    where: { list, label: { equals: label, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (clash) throw new AppError(`"${label}" is already in this list`, 409);
}

export const colorOk = (c: string | null | undefined) => c === undefined || c === null || HEX.test(c);

/** Checks that ids exist, are in the given list and (for new choices) are active. */
export async function assertValues(list: ListName, ids: string[], keepIds: string[] = []): Promise<void> {
  if (ids.length === 0) return;
  const rows = await prisma.listValue.findMany({ where: { id: { in: ids } } });
  const bad = ids.filter((id) => {
    const r = rows.find((x) => x.id === id);
    return !r || r.list !== list || (!r.active && !keepIds.includes(id));
  });
  if (bad.length) throw new AppError(`Not a current ${LISTS[list].label.toLowerCase()} value`, 400);
}
