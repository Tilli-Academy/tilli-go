// N/A counts as done for dependencies (review item 8). Covers the API checks
// (canTaskExecute / assertDependenciesMet, also used by acknowledge) and the
// scheduler's batch check. Run: npm test (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.ACK_TOKEN_SECRET ??= 'test-ack-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

const prisma = require('../src/config/prisma');
const deps = require('../src/services/dependencyService');
const { isDone, ALLOWED_TRANSITIONS, LOCKED_STATUSES } = require('../src/types');

// Prisma builds its model helpers on the fly, so swap in plain objects.
const fake = (name: string, methods: Record<string, unknown>) => Object.defineProperty(prisma, name, { value: methods, configurable: true });

/** Task B waits for task A, whose status is `aStatus`. */
function plan(aStatus: string) {
  fake('task', {
    findUnique: async () => ({ id: 'B', projectId: 'P' }),
    findMany: async () => [{ id: 'B', projectId: 'P' }],
  });
  fake('taskDependency', {
    findMany: async () => [{ taskId: 'B', dependsOnTaskId: 'A', dependsOn: { id: 'A', taskName: 'Optional step', status: aStatus, projectId: 'P' } }],
  });
}

test('done = Completed or N/A', () => {
  assert.equal(isDone('Completed'), true);
  assert.equal(isDone('N/A'), true);
  for (const s of ['Pending', 'Triggered', 'Acknowledged', 'Blocked']) assert.equal(isDone(s), false, s);
});

test('API check: a task waiting on an N/A task can start', async () => {
  plan('N/A');
  assert.deepEqual(await deps.canTaskExecute('B'), { executable: true, blockingTasks: [] });
  await deps.assertDependenciesMet('B'); // does not throw
});

test('API check: a task waiting on a Pending task cannot start', async () => {
  plan('Pending');
  const r = await deps.canTaskExecute('B');
  assert.equal(r.executable, false);
  await assert.rejects(deps.assertDependenciesMet('B'), /Dependencies not completed/);
});

test('scheduler batch check: N/A releases the task, Pending blocks it', async () => {
  plan('N/A');
  assert.equal((await deps.canTasksExecuteBatch(['B'])).get('B').executable, true);
  plan('Blocked');
  assert.deepEqual((await deps.canTasksExecuteBatch(['B'])).get('B'), { executable: false, blockingDepIds: ['A'] });
});

test('N/A is locked like Completed and can be set until work starts', () => {
  assert.equal(LOCKED_STATUSES.has('N/A'), true);
  assert.equal(ALLOWED_TRANSITIONS['N/A'].size, 0, 'nothing leaves N/A');
  for (const from of ['Pending', 'Blocked', 'Triggered']) assert.equal(ALLOWED_TRANSITIONS[from].has('N/A'), true, from);
  assert.equal(ALLOWED_TRANSITIONS.Acknowledged.has('N/A'), false, 'started work is completed, not N/A');
});
