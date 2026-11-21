import { test, expect } from '../fixtures/auth.fixture';
import { uniqueProjectCode, uniqueProjectName } from '../helpers/constants';
import { call } from '../helpers/http';

/**
 * Plan changes that arrive at the same moment (audit follow-up). The API serialises
 * changes to one project's plan, so the rules hold even under concurrent requests.
 */
test.describe('Concurrent plan changes (API)', () => {
  let projectId: string;
  let admin: string;
  const slot = (h: number) => ({ plannedStartTime: `2031-06-01T${String(h).padStart(2, '0')}:00:00.000Z`, plannedEndTime: `2031-06-01T${String(h + 1).padStart(2, '0')}:00:00.000Z` });
  const mk = async (taskName: string, extra: Record<string, unknown> = {}) => {
    const r = await call('POST', '/tasks', admin, { projectId, system: 'FOL', taskName, ...extra });
    expect(r.status).toBe(201);
    return r.data;
  };

  test.beforeEach(async ({ apiHelper }) => {
    admin = apiHelper.getToken();
    projectId = (await apiHelper.createProject(uniqueProjectName(), uniqueProjectCode())).id;
  });
  test.afterEach(async ({ apiHelper }) => {
    await apiHelper.deleteProject(projectId).catch(() => {});
  });

  test('two parallel tasks given the same owner at once: never both saved', async ({ testUser }) => {
    for (let i = 0; i < 3; i++) {
      const a = await mk(`Parallel A${i}`, slot(2 + 2 * i));
      const b = await mk(`Parallel B${i}`, slot(2 + 2 * i));
      const res = await Promise.all([a, b].map((t) => call('PUT', `/tasks/${t.id}`, admin, { assignedUserId: testUser.id })));
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    }
  });

  test('two clashing tasks created at once: one saved, one refused', async ({ testUser }) => {
    const res = await Promise.all([1, 2].map((n) => call('POST', '/tasks', admin, { projectId, system: 'FOL', taskName: `Same slot ${n}`, assignedUserId: testUser.id, ...slot(10) })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  test('tasks created at once get unique sequence numbers', async () => {
    const res = await Promise.all(Array.from({ length: 6 }, (_, n) => call('POST', '/tasks', admin, { projectId, system: 'FOL', taskName: `Seq ${n}` })));
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(new Set(res.map((r) => r.data.sequenceNumber)).size).toBe(6);
  });

  test('A→B and B→A saved at once never make a cycle', async () => {
    for (let i = 0; i < 3; i++) {
      const a = await mk(`Cycle A${i}`);
      const b = await mk(`Cycle B${i}`);
      const [x, y] = await Promise.all([
        call('PUT', `/tasks/${a.id}`, admin, { dependencies: [b.id] }),
        call('PUT', `/tasks/${b.id}`, admin, { dependencies: [a.id] }),
      ]);
      expect([x.status, y.status]).not.toEqual([200, 200]);
    }
  });

  test('deleting a task while another starts depending on it: never both', async () => {
    for (let i = 0; i < 3; i++) {
      const a = await mk(`Delete A${i}`);
      const b = await mk(`Delete B${i}`);
      const [del, dep] = await Promise.all([
        call('DELETE', `/tasks/${a.id}`, admin),
        call('PUT', `/tasks/${b.id}`, admin, { dependencies: [a.id] }),
      ]);
      expect([204, 409]).toContain(del.status);
      expect(del.status === 204 && dep.status === 200).toBe(false);
    }
  });

  test('two status changes at the same moment (e.g. N/A vs Acknowledged): only one is saved', async ({ apiHelper, testUser }) => {
    for (let i = 0; i < 3; i++) {
      const t = await mk(`Status race ${i}`, { assignedUserId: testUser.id });
      await apiHelper.setTaskStatus(t.id, 'Triggered');
      const [na, ack] = await Promise.all([
        call('PUT', `/tasks/${t.id}`, admin, { status: 'N/A' }),
        call('PUT', `/tasks/${t.id}`, admin, { status: 'Acknowledged' }),
      ]);
      // One wins; the other gets 409 (changed meanwhile) or 400 (no longer a valid move)
      expect([na.status, ack.status].filter((s) => s === 200)).toHaveLength(1);
      const final = (await call('GET', `/tasks/${t.id}`, admin)).data.status;
      expect(final).toBe(na.status === 200 ? 'N/A' : 'Acknowledged');
    }
  });
});
