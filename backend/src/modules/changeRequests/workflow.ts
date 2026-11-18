/**
 * Change-request life cycle as a small state machine.
 * Forward moves follow the happy path. "Back" moves (bug found, rollback) are
 * allowed but need a reason, so the history explains itself.
 * The backend is the source of truth: the UI only shows what this file allows.
 */
export const CR_STATUSES = ['NEW', 'ASSESS', 'SCHEDULED', 'IMPLEMENT', 'REVIEW', 'CLOSED', 'CANCELLED'] as const;
export type CrStatus = (typeof CR_STATUSES)[number];

export const OPEN_STATUSES: CrStatus[] = ['NEW', 'ASSESS', 'SCHEDULED', 'IMPLEMENT', 'REVIEW'];

export interface Transition {
  to: CrStatus;
  label: string;
  kind: 'forward' | 'back' | 'cancel';
  needsReason: boolean;
  /** A CR decision: only users with the cr.decide permission may make it. */
  approverOnly?: boolean;
}

const TRANSITIONS: Record<CrStatus, Transition[]> = {
  NEW: [
    { to: 'ASSESS', label: 'Submit for assessment', kind: 'forward', needsReason: false },
    { to: 'CANCELLED', label: 'Cancel', kind: 'cancel', needsReason: true },
  ],
  // Every way out of Assess is a decision: approve, send back or reject.
  ASSESS: [
    { to: 'SCHEDULED', label: 'Approve & schedule', kind: 'forward', needsReason: false, approverOnly: true },
    { to: 'NEW', label: 'Send back for changes', kind: 'back', needsReason: true, approverOnly: true },
    { to: 'CANCELLED', label: 'Reject / cancel', kind: 'cancel', needsReason: true, approverOnly: true },
  ],
  SCHEDULED: [
    { to: 'IMPLEMENT', label: 'Start implementation', kind: 'forward', needsReason: false },
    { to: 'ASSESS', label: 'Bug found - back to assess', kind: 'back', needsReason: true },
    { to: 'CANCELLED', label: 'Cancel', kind: 'cancel', needsReason: true },
  ],
  IMPLEMENT: [
    { to: 'REVIEW', label: 'Deployment done - review', kind: 'forward', needsReason: false },
    { to: 'SCHEDULED', label: 'Roll back - reschedule', kind: 'back', needsReason: true },
  ],
  REVIEW: [
    { to: 'CLOSED', label: 'Verify & close', kind: 'forward', needsReason: false },
    { to: 'IMPLEMENT', label: 'Issue found - reopen', kind: 'back', needsReason: true },
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
