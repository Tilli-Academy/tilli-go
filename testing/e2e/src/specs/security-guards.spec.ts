import * as crypto from 'crypto';
import { test, expect } from '../fixtures/auth.fixture';
import { API_URL, TEST_PASSWORD, uniqueEmail, uniqueName, uniqueProjectCode, uniqueProjectName } from '../helpers/constants';

/**
 * API-level guards from the PR #7 code audit:
 *   - permissions are enforced by the server (a plain user can't do admin things)
 *   - a task that later steps wait for can't be deleted
 *   - uploads: allowed types only, checked against the file's content
 *   - email links: must name the current owner; double clicks save once
 * The email-link tests sign their own links, so they need ACK_TOKEN_SECRET (the
 * same value the API uses); without it they are skipped.
 */
type Res = { status: number; data: any };
async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? (body as Buffer) : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

test.describe('Security guards (API)', () => {
  let projectId: string;
  let admin: string;

  test.beforeEach(async ({ apiHelper }) => {
    admin = apiHelper.getToken();
    projectId = (await apiHelper.createProject(uniqueProjectName(), uniqueProjectCode())).id;
  });

  test.afterEach(async ({ apiHelper }) => {
    await apiHelper.deleteProject(projectId).catch(() => {});
  });

  test('a plain user cannot use admin-only actions', async ({ apiHelper }) => {
    const reg = await call('POST', '/auth/register', undefined, { email: uniqueEmail(), password: TEST_PASSWORD, name: uniqueName() });
    expect(reg.status).toBe(201);
    const user = reg.data.token as string;
    const task = await apiHelper.createTask(projectId, 'Permission probe');

    const perms = await call('GET', '/auth/permissions', user);
    expect(JSON.stringify(perms.data)).not.toContain('task.delete');
    expect((await call('POST', '/projects', user, { name: 'nope', code: uniqueProjectCode() })).status).toBe(403);
    expect((await call('DELETE', `/tasks/${task.id}`, user)).status).toBe(403);
    expect((await call('POST', '/lists/team', user, { label: 'nope' })).status).toBe(403);
    // what a plain user IS allowed to do still works
    expect((await call('PUT', `/tasks/${task.id}`, user, { notes: 'edited by a user' })).status).toBe(200);
    // no token at all
    expect((await call('GET', '/projects')).status).toBe(401);
  });

  test('a task that a later step waits for cannot be deleted', async ({ apiHelper }) => {
    const a = await apiHelper.createTask(projectId, 'Step A');
    const b = await call('POST', '/tasks', admin, { projectId, system: 'FOL', taskName: 'Step B', dependencies: [a.id] });
    expect(b.status).toBe(201);

    const refused = await call('DELETE', `/tasks/${a.id}`, admin);
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain('Step B');
    expect((await call('GET', `/tasks/${a.id}`, admin)).status).toBe(200);

    expect((await call('PUT', `/tasks/${b.data.id}`, admin, { status: 'N/A' })).status).toBe(200);
    expect((await call('DELETE', `/tasks/${a.id}`, admin)).status).toBe(204);
  });

  test('uploads accept real files of allowed types only', async () => {
    const lists = (await call('GET', '/lists', admin)).data.lists;
    const pick = (list: string, label: string) => lists[list].find((v: { label: string }) => v.label === label)?.id;
    const me = (await call('GET', '/auth/me', admin)).data;
    const cr = await call('POST', '/change-requests', admin, {
      title: `E2E uploads ${Date.now()}`, description: 'upload checks', productIds: [lists.product[0].id],
      changeTypeId: pick('change_type', 'Product Enhancement'), releaseTypeId: pick('release_type', 'Minor'), priorityId: pick('priority', 'Low'),
      impact: 'LOW', risk: 'LOW', plannedGoLive: '2031-03-01T21:00:00-05:00', assigneeId: (me.user ?? me).id, reporterId: (me.user ?? me).id, projectId,
    });
    expect(cr.status).toBe(201);
    const up = (name: string, data: Buffer, type?: string) =>
      call('POST', `/change-requests/${cr.data.id}/attachments`, admin, data, { 'X-File-Name': encodeURIComponent(name), ...(type ? { 'X-File-Type': type } : {}) });

    const pdf = await up('runbook.pdf', Buffer.from('%PDF-1.4\n'), 'text/html');
    expect(pdf.status).toBe(201);
    expect(pdf.data.mimeType).toBe('application/pdf'); // from the file, not the browser's claim

    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    expect((await up('setup.exe', exe)).status).toBe(415);
    expect((await up('setup.pdf', exe)).status).toBe(415); // renamed executable
    expect((await up('page.html', Buffer.from('<script>alert(1)</script>'))).status).toBe(415);
    expect((await up('logo.svg', Buffer.from('<svg onload="x()"/>'))).status).toBe(415);
  });

  test.describe('email links', () => {
    const secret = process.env.ACK_TOKEN_SECRET;
    test.skip(!secret, 'set ACK_TOKEN_SECRET (same as the API) to run the email-link tests');
    const link = (taskId: string, uid?: string, exp = Date.now() + 3_600_000) => {
      const p = Buffer.from(JSON.stringify(uid ? { taskId, exp, uid } : { taskId, exp })).toString('base64url');
      return `${p}.${crypto.createHmac('sha256', secret!).update(p).digest('base64url')}`;
    };

    test('links must name the current owner and not be expired or edited', async ({ apiHelper, testUser }) => {
      const task = await apiHelper.createTask(projectId, 'Link checks');
      await apiHelper.setTaskStatus(task.id, 'Triggered');
      const good = link(task.id, testUser.id);

      expect((await call('GET', `/acknowledge/preview?task_id=${task.id}`, undefined, undefined, { 'X-Link-Token': good })).status).toBe(200);
      expect((await call('POST', '/acknowledge', undefined, { task_id: task.id, token: link(task.id) })).status).toBe(403); // no owner
      expect((await call('POST', '/acknowledge', undefined, { task_id: task.id, token: link(task.id, '00000000-0000-0000-0000-000000000000') })).status).toBe(403); // old owner
      expect((await call('POST', '/acknowledge', undefined, { task_id: task.id, token: link(task.id, testUser.id, Date.now() - 1000) })).data.error).toBe('Token expired');
      expect((await call('POST', '/acknowledge', undefined, { task_id: task.id, token: `${good.slice(0, -3)}xyz` })).status).toBe(403);
      expect((await apiHelper.getTask(task.id)).status).toBe('Triggered');
    });

    test('several clicks at the same moment are saved once', async ({ apiHelper, testUser }) => {
      const task = await apiHelper.createTask(projectId, 'Double click');
      await apiHelper.setTaskStatus(task.id, 'Triggered');
      const token = link(task.id, testUser.id);

      const acks = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/acknowledge', undefined, { task_id: task.id, token })));
      expect(acks.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(acks.filter((r) => r.data.message === 'Task acknowledged successfully')).toHaveLength(1);

      const done = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/complete', undefined, { task_id: task.id, token })));
      expect(done.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(done.filter((r) => r.data.message !== 'Task already completed')).toHaveLength(1);
      expect((await apiHelper.getTask(task.id)).status).toBe('Completed');
    });
  });
});
