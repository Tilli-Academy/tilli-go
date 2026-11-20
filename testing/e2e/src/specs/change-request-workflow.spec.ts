import { test, expect } from '../fixtures/auth.fixture';
import { TEST_PASSWORD, uniqueEmail, uniqueName } from '../helpers/constants';
import { call, createChangeRequest } from '../helpers/http';

/**
 * Change request workflow rules enforced by the API (audit follow-up): permissions,
 * invalid moves, reasons, finished CRs, and decisions made at the same moment.
 */
test.describe('Change request workflow (API)', () => {
  let admin: string;
  const created: string[] = [];
  const newCr = async (title: string) => {
    const cr = await createChangeRequest(admin, `E2E ${title} ${Date.now()}`);
    created.push(cr.id);
    return cr;
  };
  const toAssess = async (id: string) => expect((await call('POST', `/change-requests/${id}/transition`, admin, { to: 'ASSESS' })).status).toBe(200);

  test.beforeEach(async ({ apiHelper }) => { admin = apiHelper.getToken(); });
  test.afterAll(async () => {
    // Test CRs are closed/cancelled so they don't clutter the board (there is no delete).
    for (const id of created) {
      const cr = (await call('GET', `/change-requests/${id}`, admin)).data;
      if (cr && !['CLOSED', 'CANCELLED'].includes(cr.status)) await call('POST', `/change-requests/${id}/transition`, admin, { to: 'CANCELLED', reason: 'e2e cleanup' });
    }
  });

  test('two CAB decisions at the same moment: one wins, nothing is overwritten', async () => {
    const cr = await newCr('decisions');
    await toAssess(cr.id);
    const [a, b] = await Promise.all([
      call('POST', `/change-requests/${cr.id}/decision`, admin, { decision: 'REQUEST_INFO', reason: 'need the rollback plan' }),
      call('POST', `/change-requests/${cr.id}/decision`, admin, { decision: 'REJECTED', reason: 'not this release' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const after = (await call('GET', `/change-requests/${cr.id}`, admin)).data;
    const winner = a.status === 200 ? 'NEW' : 'CLOSED';
    expect(after.status).toBe(winner);
    expect(after.events.filter((e: { fromStatus: string }) => e.fromStatus === 'ASSESS')).toHaveLength(1);
  });

  test('two status moves at the same moment: only one is applied', async () => {
    const cr = await newCr('moves');
    // Two people press "Submit for assessment" together: one move, one history entry.
    const res = await Promise.all([1, 2].map(() => call('POST', `/change-requests/${cr.id}/transition`, admin, { to: 'ASSESS' })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const after = (await call('GET', `/change-requests/${cr.id}`, admin)).data;
    expect(after.events.filter((e: { kind: string }) => e.kind === 'STATUS')).toHaveLength(1);
  });

  test('invalid moves, missing reasons and missing permissions are refused', async () => {
    const cr = await newCr('negative');
    expect((await call('POST', `/change-requests/${cr.id}/transition`, admin, { to: 'IMPLEMENT' })).status).toBe(409); // skips steps
    await toAssess(cr.id);
    expect((await call('POST', `/change-requests/${cr.id}/transition`, admin, { to: 'SCHEDULED' })).status).toBe(409); // must be a CAB decision
    expect((await call('POST', `/change-requests/${cr.id}/decision`, admin, { decision: 'REJECTED' })).status).toBe(400); // reason required

    const reg = await call('POST', '/auth/register', undefined, { email: uniqueEmail(), password: TEST_PASSWORD, name: uniqueName() });
    expect(reg.status).toBe(201);
    const user = reg.data.token as string;
    expect((await call('POST', `/change-requests/${cr.id}/decision`, user, { decision: 'APPROVED' })).status).toBe(403); // not an approver
    expect((await call('POST', `/change-requests/${cr.id}/transition`, user, { to: 'CANCELLED', reason: 'not mine to cancel' })).status).toBe(403);
    expect((await call('GET', `/change-requests/${cr.id}`, admin)).data.status).toBe('ASSESS');
  });

  test('a finished change request cannot be changed', async () => {
    const cr = await newCr('finished');
    expect((await call('POST', `/change-requests/${cr.id}/transition`, admin, { to: 'CANCELLED', reason: 'no longer needed' })).status).toBe(200);
    expect((await call('PATCH', `/change-requests/${cr.id}`, admin, { title: 'edited after cancel' })).status).toBe(409);
    expect((await call('POST', `/change-requests/${cr.id}/transition`, admin, { to: 'NEW' })).status).toBe(409);
    const up = await call('POST', `/change-requests/${cr.id}/attachments`, admin, Buffer.from('%PDF-1.4\n%%EOF\n'), { 'X-File-Name': 'late.pdf' });
    expect(up.status).toBe(409);
  });
});
