// Stale status reads (PR #7 final review): a task's status is only saved if it is still
// the status every check was made against; the scheduler's moves likewise. History
// rows are written only when the save happened. Run: npm test (no database: faked).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.ACK_TOKEN_SECRET ??= 'test-ack-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

const prisma = require('../src/config/prisma');
const taskService = require('../src/services/taskService');
const { moveStatus } = require('../src/services/schedulerService');

type Row = { id: string; status: string; [k: string]: unknown };
const fake = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value, configurable: true });

/**
 * One task row. `onFirstRead` runs right after the service's first read: that's where a
 * concurrent change "lands" (between read and save). Records every write and history row.
 */
function db(start: Partial<Row>, onFirstRead?: (row: Row) => void) {
  const row: Row = {
    id: 't1', status: 'Triggered', projectId: 'p1', sequenceNumber: 1, taskName: 'Deploy', system: 'FOL',
    assignedUserId: 'u1', assignedTeam: null, plannedStartTime: new Date('2031-01-01T10:00:00Z'), plannedEndTime: new Date('2031-01-01T11:00:00Z'),
    notes: null, changeRequestId: null, dependsOn: [], ...start,
  };
  const writes: Array<{ where: Row; data: Row }> = [];
  const history: unknown[] = [];
  let reads = 0;
  const task = {
    findUnique: async () => {
      const snapshot = { ...row };
      if (reads++ === 0 && onFirstRead) onFirstRead(row);
      return snapshot;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      if (where.status !== undefined && where.status !== row.status) return { count: 0 };
      writes.push({ where, data });
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  const auditLog = { create: async (a: unknown) => history.push(a), createMany: async (a: { data: unknown[] }) => history.push(...a.data) };
  const tx = { task, auditLog, taskDependency: { findMany: async () => [], deleteMany: async () => ({}), createMany: async () => ({}) }, project: { findUnique: async () => ({ code: 'REL' }) }, $executeRaw: async () => 1 };
  fake('task', { ...task, findMany: async () => [row] });
  fake('auditLog', auditLog);
  fake('taskDependency', tx.taskDependency);
  fake('project', { findUnique: async () => ({ code: 'REL', startAlertsEnabled: false }) });
  // Interactive transactions run the callback against the same fakes.
  fake('$transaction', async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  return { row, writes, history };
}

// The scheduler module opens the BullMQ queues (Redis); close them so the run can exit.
after(async () => {
  const q = require('../src/services/queueService');
  await Promise.allSettled([q.taskQueue.close(), q.emailQueue.close()]);
});

const rejects409 = (p: Promise<unknown>) => assert.rejects(p, (e: { status?: number }) => e.status === 409);

// ── Task service ────────────────────────────────────────────────────────────

test('status change: saved only against the status it was checked with', async () => {
  const { row, writes, history } = db({ status: 'Triggered' });
  await taskService.update('t1', { status: 'N/A' }, { dependencyPreChecked: true });
  assert.equal(row.status, 'N/A');
  assert.equal(writes[0]!.where.status, 'Triggered');
  assert.equal(history.length, 1);
});

test('grid "N/A" while the owner acknowledges (Triggered → N/A vs → Acknowledged): 409, nothing saved, no history', async () => {
  const { row, writes, history } = db({ status: 'Triggered' }, (r) => { r.status = 'Acknowledged'; });
  await rejects409(taskService.update('t1', { status: 'N/A' }, { dependencyPreChecked: true }));
  assert.equal(row.status, 'Acknowledged', 'the acknowledgement is not overwritten');
  assert.equal(writes.length, 0);
  assert.equal(history.length, 0, 'no history row for a change that did not happen');
});

test('the reverse race (→ Acknowledged while marked N/A meanwhile) is refused too', async () => {
  const { row, history } = db({ status: 'Triggered' }, (r) => { r.status = 'N/A'; });
  await rejects409(taskService.update('t1', { status: 'Acknowledged' }, { dependencyPreChecked: true }));
  assert.equal(row.status, 'N/A');
  assert.equal(history.length, 0);
});

test('a plan edit (+ status) re-reads under the lock: if the status moved, it is refused, not re-decided', async () => {
  // Validated as Triggered → N/A; meanwhile acknowledged. Before the fix the save used the
  // re-read status and could overwrite Acknowledged with N/A.
  const { row, writes, history } = db({ status: 'Triggered' }, (r) => { r.status = 'Acknowledged'; });
  await rejects409(taskService.update('t1', { status: 'N/A', notes: 'skip', plannedStartTime: new Date('2031-01-01T12:00:00Z') }, { dependencyPreChecked: true }));
  assert.equal(row.status, 'Acknowledged');
  assert.equal(writes.length, 0);
  assert.equal(history.length, 0);
});

test('a planning-field edit while the status changes (e.g. marked N/A) is refused, not applied to the N/A task', async () => {
  const start = new Date('2031-01-01T10:00:00Z');
  const { row, history } = db({ status: 'Triggered', plannedStartTime: start }, (r) => { r.status = 'N/A'; });
  await rejects409(taskService.update('t1', { plannedStartTime: new Date('2031-01-01T15:00:00Z') }));
  assert.equal((row.plannedStartTime as Date).getTime(), start.getTime());
  assert.equal(history.length, 0);
});

test('a planning-field edit with no concurrent change still works', async () => {
  const { row, history } = db({ status: 'Pending' });
  await taskService.update('t1', { notes: 'bring the runbook' });
  assert.equal(row.notes, 'bring the runbook');
  assert.equal(history.length, 1);
});

// ── Scheduler moves ─────────────────────────────────────────────────────────

test('scheduler Blocked → Pending: applied with one history row when still Blocked', async () => {
  const { row, history } = db({ status: 'Blocked' });
  assert.equal(await moveStatus('t1', 'Blocked', 'Pending'), true);
  assert.equal(row.status, 'Pending');
  assert.equal(history.length, 1);
});

test('scheduler Blocked → Pending racing with "N/A": not overwritten, no history', async () => {
  const { row, history } = db({ status: 'Blocked' });
  row.status = 'N/A'; // marked N/A after the scheduler listed Blocked tasks
  assert.equal(await moveStatus('t1', 'Blocked', 'Pending'), false);
  assert.equal(row.status, 'N/A');
  assert.equal(history.length, 0);
});

test('scheduler Pending → Blocked racing with the worker triggering it: not overwritten, no history', async () => {
  const { row, history } = db({ status: 'Pending' });
  row.status = 'Triggered'; // the worker triggered it after the scheduler read it
  assert.equal(await moveStatus('t1', 'Pending', 'Blocked'), false);
  assert.equal(row.status, 'Triggered');
  assert.equal(history.length, 0);
});
