import type { Request, Response, NextFunction, RequestHandler } from 'express';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/errors';

/**
 * The one place that decides what a user may do. Routes and services ask for a
 * permission and never look at role names, so roles can be renamed or reshaped
 * (and later mapped to Microsoft Entra groups) without code changes.
 *
 * Which role has which permission lives in the role_permissions table (seeded by
 * migration; a Roles page in a follow-up PR will edit it).
 */
export const PERMISSIONS = [
  'cr.create', // raise a change request
  'cr.edit', // edit a CR, comment, attach, link, move it along the workflow
  'cr.decide', // CAB decision: Approve / Request more info / Defer / Reject
  'cr.close', // close or cancel a change request
  'cutover.manage', // start-time alerts switch, live rehearsal
  'task.edit', // create and edit cutover tasks
  'task.delete', // delete cutover tasks
  'project.manage', // create, edit and delete projects
  'admin.lists', // Admin → Lists
] as const;
export type Permission = (typeof PERMISSIONS)[number];

interface HasRole {
  role: string;
}

/**
 * Cached copy of role_permissions, tagged with the version it was read at. Every check
 * reads the one-row permission_version table (a trigger bumps it on any change to
 * role_permissions) and reloads when it differs, so a revoked permission stops working
 * on the very next request, on every API instance.
 */
let cache: { version: bigint; byRole: Map<string, Set<string>> } | null = null;

async function table(): Promise<Map<string, Set<string>>> {
  const row = await prisma.permissionVersion.findUnique({ where: { id: 1 }, select: { version: true } });
  const version = row?.version ?? -1n;
  if (cache && cache.version === version) return cache.byRole;
  const rows = await prisma.rolePermission.findMany();
  const byRole = new Map<string, Set<string>>();
  for (const r of rows) byRole.set(r.role, (byRole.get(r.role) ?? new Set()).add(r.permission));
  cache = { version, byRole };
  return byRole;
}

/** For tests. (Not needed after editing role_permissions: the version check handles that.) */
export function clearPermissionCache(): void {
  cache = null;
}

export async function permissionsFor(user: HasRole): Promise<Permission[]> {
  const set = (await table()).get(user.role) ?? new Set<string>();
  return PERMISSIONS.filter((p) => set.has(p));
}

export async function hasPermission(user: HasRole, permission: Permission): Promise<boolean> {
  return (await table()).get(user.role)?.has(permission) ?? false;
}

export async function assertPermission(user: HasRole, permission: Permission, message?: string): Promise<void> {
  if (!(await hasPermission(user, permission))) {
    throw new AppError(message ?? `You don't have permission to do this (${permission})`, 403);
  }
}

export async function rolesWith(permission: Permission): Promise<string[]> {
  return [...(await table()).entries()].filter(([, set]) => set.has(permission)).map(([role]) => role);
}

/** Route guard: use after `auth`. */
export function requirePermission(permission: Permission, message?: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    assertPermission(req.user!, permission, message).then(() => next(), next);
  };
}
