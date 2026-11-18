/**
 * The one place that decides what a user may do. Routes and services ask
 * hasPermission(user, '...') and never look at roles themselves, so the source
 * can later switch from CR_APPROVER_ROLES to Microsoft Entra app roles or groups
 * without touching every route.
 */
export type Permission = 'cr.decide';

interface HasRole {
  role: string;
}

/** Roles that may approve, send back or reject a change request. Tilli-go roles are "user" and "admin". */
function decideRoles(): string[] {
  return (process.env.CR_APPROVER_ROLES || 'admin').split(',').map((r) => r.trim()).filter(Boolean);
}

export function rolesWith(permission: Permission): string[] {
  switch (permission) {
    case 'cr.decide':
      return decideRoles();
  }
}

export function hasPermission(user: HasRole, permission: Permission): boolean {
  return rolesWith(permission).includes(user.role);
}
