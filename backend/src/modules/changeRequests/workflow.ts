import type { Permission } from '../auth/permissions';

/**
 * Change-request life cycle as a small state machine.
 * Forward moves follow the happy path. "Back" moves (bug found, rollback) are
 * allowed but need a reason, so the history explains itself.
 * Leaving Assess is a CAB decision (see DECISIONS), made only with cr.decide.
 * The backend is the source of truth: the UI only shows what this file allows.
 */
export const CR_STATUSES = ['NEW', 'ASSESS', 'SCHEDULED', 'IMPLEMENT', 'REVIEW', 'CLOSED', 'CANCELLED'] as const;
export type CrStatus = (typeof CR_STATUSES)[number];

export const OPEN_STATUSES: CrStatus[] = ['NEW', 'ASSESS', 'SCHEDULED', 'IMPLEMENT', 'REVIEW'];
/** No edits once finished. */
export const FINISHED: string[] = ['CLOSED', 'CANCELLED'];

export interface Transition {
  to: CrStatus;
  label: string;
  kind: 'forward' | 'back' | 'cancel';
  needsReason: boolean;
  permission: Permission;
}

const TRANSITIONS: Record<CrStatus, Transition[]> = {
  NEW: [
    { to: 'ASSESS', label: 'Submit for assessment', kind: 'forward', needsReason: false, permission: 'cr.edit' },
    { to: 'CANCELLED', label: 'Cancel', kind: 'cancel', needsReason: true, permission: 'cr.close' },
  ],
  ASSESS: [{ to: 'CANCELLED', label: 'Withdraw', kind: 'cancel', needsReason: true, permission: 'cr.close' }],
  SCHEDULED: [
    { to: 'IMPLEMENT', label: 'Start implementation', kind: 'forward', needsReason: false, permission: 'cr.edit' },
    { to: 'ASSESS', label: 'Bug found - back to assess', kind: 'back', needsReason: true, permission: 'cr.edit' },
    { to: 'CANCELLED', label: 'Cancel', kind: 'cancel', needsReason: true, permission: 'cr.close' },
  ],
  IMPLEMENT: [
    { to: 'REVIEW', label: 'Deployment done - review', kind: 'forward', needsReason: false, permission: 'cr.edit' },
    { to: 'SCHEDULED', label: 'Roll back - reschedule', kind: 'back', needsReason: true, permission: 'cr.edit' },
  ],
  REVIEW: [
    { to: 'CLOSED', label: 'Verify & close', kind: 'forward', needsReason: false, permission: 'cr.close' },
    { to: 'IMPLEMENT', label: 'Issue found - reopen', kind: 'back', needsReason: true, permission: 'cr.edit' },
  ],
  CLOSED: [],
  CANCELLED: [],
};

export function transitionsFor(status: string): Transition[] {
  return TRANSITIONS[status as CrStatus] ?? [];
}

export function findTransition(from: string, to: string): Transition | undefined {
  return transitionsFor(from).find((t) => t.to === to);
}

/**
 * CAB decisions (approver only, from Assess). Keys are fixed; labels and colours
 * come from the "decision" list.
 *   APPROVED      → Scheduled; sets Date Approved and Approved By
 *   REQUEST_INFO  → back to New, reason required, voids any approval ("Send back")
 *   DEFERRED      → stays in Assess, moved to a later Date Presented
 *   REJECTED      → Closed (Rejected), reason required
 */
export const DECISIONS = {
  APPROVED: { to: 'SCHEDULED', needsReason: false },
  REQUEST_INFO: { to: 'NEW', needsReason: true },
  DEFERRED: { to: 'ASSESS', needsReason: false },
  REJECTED: { to: 'CLOSED', needsReason: true },
} as const satisfies Record<string, { to: CrStatus; needsReason: boolean }>;
export type Decision = keyof typeof DECISIONS;
export const DECISION_KEYS = Object.keys(DECISIONS) as Decision[];

export const LEVEL_KEYS = ['LOW', 'MEDIUM', 'HIGH'] as const;
