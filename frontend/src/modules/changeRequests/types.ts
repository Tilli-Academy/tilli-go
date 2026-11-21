export type CrStatus = 'NEW' | 'ASSESS' | 'SCHEDULED' | 'IMPLEMENT' | 'REVIEW' | 'CLOSED' | 'CANCELLED';

export interface Person { id: string; name: string; email: string; role: string }

/** A managed-list value (Admin → Lists). */
export interface ListValue {
  id: string;
  label: string;
  color: string | null;
  active: boolean;
  key?: string | null;
  required?: boolean;
  sortOrder?: number;
  /** Admin view only: how many change requests use it */
  inUse?: number;
}
export type ListName = 'change_type' | 'release_type' | 'product' | 'priority' | 'team' | 'supporting_document' | 'risk' | 'decision';
export type Lists = Record<ListName, ListValue[]>;
export type DecisionKey = 'APPROVED' | 'REQUEST_INFO' | 'DEFERRED' | 'REJECTED';

export interface CutoverStats { total: number; completed: number; blocked: number }

export interface ChangeRequest {
  id: string;
  number: number;
  title: string;
  description: string;
  changeType: ListValue | null;
  releaseType: ListValue | null;
  priority: ListValue | null;
  team: ListValue | null;
  products: ListValue[];
  /** LOW | MEDIUM | HIGH (labels/colours from the risk list) */
  impact: string | null;
  risk: string;
  datePresented: string | null;
  codeFreezeDate: string | null;
  downtimeHours: number | null;
  decision: DecisionKey | null;
  decidedAt: string | null;
  customer: string | null;
  labels: string[];
  plannedGoLive: string;
  dueDate: string | null;
  needsCutover: boolean;
  status: CrStatus;
  assignee: Person;
  projectId: string | null;
  project: {
    id: string; code: string; name?: string; timeZone?: string;
    /** All change requests in this project (detail view only). */
    changeRequests?: { id: string; number: number; title: string; status: CrStatus }[];
  } | null;
  cutover: CutoverStats | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeListItem extends ChangeRequest { hasConflict: boolean }

export interface Transition { to: CrStatus; label: string; kind: 'forward' | 'back' | 'cancel'; needsReason: boolean; permission: string; allowed: boolean }

export interface ChangeEvent {
  id: string;
  kind: 'CREATED' | 'STATUS' | 'COMMENT' | 'ATTACHMENT' | 'CUTOVER' | 'EDIT' | 'DECISION' | 'DOCUMENT' | 'LINK';
  fromStatus: CrStatus | null;
  toStatus: CrStatus | null;
  message: string | null;
  actor: Person;
  createdAt: string;
}

export interface Attachment { id: string; fileName: string; mimeType: string; size: number; provider: string; createdAt: string }

export interface Conflict { id: string; number: number; title: string; status: CrStatus; assignee: { name: string } }

export interface ChangeDetail extends ChangeRequest {
  reporter: Person;
  approvedBy: Person | null;
  approvedAt: string | null;
  events: ChangeEvent[];
  attachments: Attachment[];
  conflicts: Conflict[];
  decidedBy: Person | null;
  documents: { documentTypeId: string; attachmentId: string | null; url: string | null; attachment: { id: string; fileName: string } | null }[];
  linked: { id: string; number: number; title: string; status: CrStatus }[];
  /** Progress of the tasks tagged with this CR (null when none are tagged). */
  ownTasks: CutoverStats | null;
  transitions: Transition[];
  canDecide: boolean;
  permissions: string[];
}

export interface CrMeta {
  users: Person[];
  permissions: string[];
  approverRoles: string[];
  canApprove: boolean;
}
