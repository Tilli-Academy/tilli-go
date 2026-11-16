export type CrStatus = 'NEW' | 'ASSESS' | 'SCHEDULED' | 'IMPLEMENT' | 'REVIEW' | 'CLOSED' | 'CANCELLED';

export interface Person { id: string; name: string; email: string; role: string }

export interface CutoverStats { total: number; completed: number; blocked: number }

export interface ChangeRequest {
  id: string;
  number: number;
  title: string;
  description: string;
  product: string;
  changeType: string;
  releaseType: string;
  priority: string;
  impact: string;
  risk: string;
  customer: string | null;
  labels: string[];
  plannedGoLive: string;
  dueDate: string | null;
  needsCutover: boolean;
  status: CrStatus;
  assignee: Person;
  projectId: string | null;
  project: { id: string; code: string; name?: string } | null;
  cutover: CutoverStats | null;
  createdAt: string;
}

export interface ChangeListItem extends ChangeRequest { hasConflict: boolean }

export interface Transition { to: CrStatus; label: string; kind: 'forward' | 'back' | 'cancel'; needsReason: boolean; approverOnly?: boolean }

export interface ChangeEvent {
  id: string;
  kind: 'CREATED' | 'STATUS' | 'COMMENT' | 'ATTACHMENT' | 'CUTOVER';
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
  transitions: Transition[];
  canApprove: boolean;
}

export interface CrMeta {
  users: Person[];
  options: { products: string[]; changeTypes: string[]; releaseTypes: string[]; priorities: string[]; levels: string[] };
  approverRoles: string[];
  canApprove: boolean;
}
