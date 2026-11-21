// In-memory stand-in for the two rows the email processor touches (one task, its
// task_alerts row). It answers the delivery claims with the same conditions as the
// real SQL in src/services/deliveryClaims.ts, one statement at a time, so tests can
// run workers concurrently, simulate crashes (old claims) and reassignments.
type Row = Record<string, any>;
export const LEASE_MS = 5 * 60 * 1000;

export interface FakeState {
  /** The tasks row as the database has it now (tests change it to simulate a reassignment). */
  task: Row;
  /** The task_alerts row, or null. */
  alert: Row | null;
  /** What the processor's first `findUnique({ include })` returns (the task as loaded). */
  loaded: () => Row;
  /** Make the "record it as sent" step fail (email went out, database write fails). */
  failRecord?: boolean;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (k === 'AND') return (cond as Row[]).every((c) => matches(row, c));
    const v = row[k] ?? null;
    if (cond === null) return v === null;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      if ('not' in cond) return v !== cond.not;
      if ('lt' in cond) return v !== null && v < cond.lt;
    }
    return v === cond;
  });
}

export function installFakeDb(prisma: any, state: FakeState) {
  const def = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value, configurable: true });
  const tick = () => new Promise((r) => setImmediate(r)); // let concurrent workers interleave

  def('task', {
    findUnique: async (args: Row) => { await tick(); return args.include ? state.loaded() : { ...state.task }; },
    updateMany: async ({ where, data }: Row) => {
      await tick();
      if (!matches(state.task, where)) return { count: 0 };
      Object.assign(state.task, data);
      return { count: 1 };
    },
  });
  def('taskAlert', {
    findUnique: async () => { await tick(); return state.alert ? { ...state.alert, notifiedUserIds: [...state.alert.notifiedUserIds] } : null; },
    createMany: async ({ data }: Row) => {
      if (state.alert) return { count: 0 };
      state.alert = { notifiedUserIds: [], claimUserId: null, claimedAt: null, attempts: 0, ...data[0] };
      return { count: 1 };
    },
    upsert: async ({ create, update }: Row) => {
      state.alert = state.alert ? Object.assign(state.alert, update) : { notifiedUserIds: [], claimUserId: null, claimedAt: null, ...create };
      return state.alert;
    },
    update: async ({ data }: Row) => Object.assign(state.alert!, data),
  });
  def('auditLog', { create: async () => ({}) });

  // claimStartAlert: values = [ownerId, to, taskId, ownerId, leaseSeconds, ownerId]
  // claimManagerNotice: values = [marker, taskId, which, which, leaseSeconds]
  def('$queryRaw', async (q: TemplateStringsArray, ownerId: string, to: string, ...rest: any[]) => {
    await tick();
    const text = q.join('?');
    if (text.includes('FROM tasks WHERE id') && text.includes('FOR SHARE')) {
      const t = state.task;
      return t ? [{ assigned_user_id: t.assignedUserId ?? null, status: t.status }] : [];
    }
    if (text.includes('FROM task_alerts WHERE task_id') && text.includes('FOR UPDATE')) {
      const al = state.alert;
      return al ? [{ claim_user_id: al.claimUserId ?? null, claimed_at: al.claimedAt ?? null, status: al.status, notified: (al.notifiedUserIds ?? []).length }] : [];
    }
    if (text.includes('reminder_sent_at IS NULL')) {
      const marker = ownerId;
      const which = rest[0];
      const a = state.alert!;
      const t = state.task;
      const free = a.claimUserId == null || a.claimedAt < new Date(Date.now() - LEASE_MS);
      const due = which === 'notice' ? a.status !== 'NO_OWNER' : a.status === 'NO_OWNER' && a.reminderSentAt == null;
      if (!free || !due || t.assignedUserId != null || !['Pending', 'Triggered'].includes(t.status)) return [];
      const now = new Date();
      Object.assign(a, { claimUserId: marker, claimedAt: now });
      return [{ claimed_at: now }];
    }
    const a = state.alert!;
    const t = state.task;
    const free = a.claimUserId === null || a.claimedAt < new Date(Date.now() - LEASE_MS);
    if (a.notifiedUserIds.includes(ownerId) || a.status === 'ACKNOWLEDGED' || !free) return [];
    if (t.assignedUserId !== ownerId || t.status !== 'Triggered') return [];
    const now = new Date();
    Object.assign(a, { claimUserId: ownerId, claimedAt: now, status: 'SENDING', recipient: to });
    return [{ claimed_at: now }];
  });
  def('$executeRaw', async (s: TemplateStringsArray, ...v: any[]) => {
    await tick();
    const a = state.alert!;
    const sql = s.join('?');
    if (sql.includes('array_append')) {
      // completeStartAlert: [ownerId, messageId, attempts, taskId, ownerId, claimedAt]
      const [ownerId, messageId, attempts, , , claimedAt] = v;
      if (a.claimUserId !== ownerId || a.claimedAt?.getTime() !== claimedAt.getTime()) return 0;
      a.notifiedUserIds.push(ownerId);
      Object.assign(a, { status: 'SENT', sentAt: new Date(), messageId, attempts, claimUserId: null, claimedAt: null });
      return 1;
    }
    // completeManagerNotice runs these inside its transaction, after locking (see $transaction below).
    if (sql.includes("status = 'NO_OWNER'")) {
      if (state.failRecord) throw new Error('database unavailable');
      Object.assign(a, { status: 'NO_OWNER', recipient: v[0], sentAt: new Date(), reminderSentAt: null, claimUserId: null, claimedAt: null });
      return 1;
    }
    if (sql.includes('reminder_sent_at = now()')) {
      if (state.failRecord) throw new Error('database unavailable');
      Object.assign(a, { reminderSentAt: new Date(), claimUserId: null, claimedAt: null });
      return 1;
    }
    if (sql.includes('DELETE FROM task_alerts')) {
      state.alert = null;
      return 1;
    }
    if (v.length === 1) {
      // in-transaction release of our claim (already verified under the lock)
      Object.assign(a, { claimUserId: null, claimedAt: null });
      return 1;
    }
    // releaseStartAlert / releaseManagerNotice: [taskId, ownerId or marker, claimedAt]
    const [, ownerId, claimedAt] = v;
    if (a.claimUserId !== ownerId || a.claimedAt?.getTime() !== claimedAt.getTime()) return 0;
    Object.assign(a, { claimUserId: null, claimedAt: null });
    return 1;
  });
  // Interactive transaction: the callback runs against the same fake. JavaScript runs it
  // without interleaving at the statements that matter here, so it behaves atomically.
  def('$transaction', async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return state;
}
