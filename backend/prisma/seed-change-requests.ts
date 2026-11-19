// Demo data for the Change Request module. Safe to re-run: it removes previous
// CR demo data (change requests + their REL-* / CR-* projects) and recreates it.
// Dates are relative to today so the demo always looks current.
// Run from backend/:  DATABASE_URL=... npm run db:seed:cr
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const DAY = 86400000;
const day = (n: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return new Date(d.getTime() + n * DAY); };
const at = (n: number, h: number, m = 0) => new Date(day(n).getTime() + (h * 60 + m) * 60000);
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function main(): Promise<void> {
  const password = await bcrypt.hash('Demo@12345', 10);
  const person = (name: string, role: 'user' | 'admin') =>
    prisma.user.upsert({
      where: { email: `${name.split(' ')[0]!.toLowerCase()}@example.com` },
      update: { name, role },
      create: { email: `${name.split(' ')[0]!.toLowerCase()}@example.com`, name, role, password, oauthProvider: 'local' },
    });
  const priya = await person('Priya Sharma', 'user');
  const rahul = await person('Rahul Verma', 'user');
  const sneha = await person('Sneha Kapoor', 'user');
  const arjun = await person('Arjun Mehta', 'user');
  const anita = await person('Anita Rao', 'admin');
  const vikram = await person('Vikram Iyer', 'admin');

  await prisma.changeRequest.deleteMany({});
  await prisma.project.deleteMany({ where: { OR: [{ code: { startsWith: 'CR-' } }, { code: { startsWith: 'REL-' } }] } });
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "change_requests_number_seq" RESTART WITH 1001`);

  type Step = { to: string; by: string; daysAgo: number; msg?: string };

  // Managed-list values (Admin → Lists). The migration creates the standard ones;
  // demo products and teams are added here if missing.
  async function value(list: string, label: string) {
    const found = await prisma.listValue.findFirst({ where: { list, label } });
    if (found) return found.id;
    const last = await prisma.listValue.aggregate({ where: { list }, _max: { sortOrder: true } });
    return (await prisma.listValue.create({ data: { list, label, sortOrder: (last._max.sortOrder ?? 0) + 1 } })).id;
  }
  const RELEASE: Record<string, string> = { 'Major release': 'Major', 'Minor release': 'Minor', Hotfix: 'Minor', Configuration: 'Minor' };
  const TEAM: Record<string, string> = { Nudge: 'Integrations', 'Tilli-go': 'Platform', 'Quality System': 'QA', 'Internal Tools': 'Platform' };
  const CAB_DAY = 2; // next CAB meeting, days from today

  async function cr(d: {
    title: string; description: string; product: string; changeType?: string; releaseType: string; priority: string;
    impact: string; risk: string; customer?: string; labels?: string[]; goLive: number; needsCutover?: boolean;
    assigneeId: string; reporterId: string; createdDaysAgo: number; path?: Step[];
  }) {
    const path = d.path ?? [];
    const last = path.map((s) => s.to).lastIndexOf('SCHEDULED');
    const approval = last >= 0 && !path.slice(last + 1).some((s) => s.to === 'ASSESS' || s.to === 'NEW') ? path[last] : undefined;
    const status = path.length ? path[path.length - 1]!.to : 'NEW';
    const c = await prisma.changeRequest.create({
      data: {
        title: d.title, description: d.description,
        changeTypeId: await value('change_type', d.changeType === 'Emergency' ? 'Emergency Fix' : 'Product Enhancement'),
        releaseTypeId: await value('release_type', RELEASE[d.releaseType] ?? 'Minor'),
        priorityId: await value('priority', d.priority),
        teamId: await value('team', TEAM[d.product] ?? 'Platform'),
        products: { create: [{ productId: await value('product', d.product) }] },
        impact: d.impact.toUpperCase(), risk: d.risk.toUpperCase(), customer: d.customer,
        labels: d.labels ?? [], plannedGoLive: day(d.goLive), needsCutover: d.needsCutover ?? true,
        datePresented: status === 'ASSESS' ? day(CAB_DAY) : approval ? ago(approval.daysAgo + 1) : null,
        codeFreezeDate: d.goLive > 2 ? day(d.goLive - 2) : null,
        downtimeHours: d.needsCutover === false ? null : 0.5,
        status,
        assigneeId: d.assigneeId, reporterId: d.reporterId,
        approvedById: approval?.by, approvedAt: approval ? ago(approval.daysAgo) : undefined,
        decision: approval ? 'APPROVED' : null, decidedById: approval?.by, decidedAt: approval ? ago(approval.daysAgo) : undefined,
        createdAt: ago(d.createdDaysAgo),
      },
    });
    await prisma.changeEvent.create({ data: { changeRequestId: c.id, kind: 'CREATED', toStatus: 'NEW', actorId: d.assigneeId, message: 'created the change request', createdAt: ago(d.createdDaysAgo) } });
    let from = 'NEW';
    for (const s of path) {
      await prisma.changeEvent.create({
        data: { changeRequestId: c.id, kind: 'STATUS', fromStatus: from, toStatus: s.to, actorId: s.by, message: s.msg ?? (s.to === 'SCHEDULED' && from === 'ASSESS' ? 'Approved' : null), createdAt: ago(s.daysAgo) },
      });
      from = s.to;
    }
    return c;
  }
  const comment = (id: string, actorId: string, message: string, daysAgo: number) =>
    prisma.changeEvent.create({ data: { changeRequestId: id, kind: 'COMMENT', actorId, message, createdAt: ago(daysAgo) } });

  /** A project groups one or more CRs (e.g. a release) and owns the optional cutover plan. */
  const project = (code: string, name: string) => prisma.project.create({ data: { code, name, startAlertsEnabled: false } });
  async function link(c: { id: string }, p: { id: string; code: string }, actorId: string, daysAgo: number) {
    await prisma.changeRequest.update({ where: { id: c.id }, data: { projectId: p.id } });
    await prisma.changeEvent.create({ data: { changeRequestId: c.id, kind: 'CUTOVER', actorId, message: `linked to project ${p.code}`, createdAt: ago(daysAgo) } });
  }

  /** Simple cutover plan: tasks every 30 min from 09:00 on the go-live day. */
  async function cutover(c: { id: string }, p: { id: string; code: string }, goLive: number, actorId: string, daysAgo: number,
    tasks: [system: string, taskName: string, team: string, ownerId: string, status: string][]) {
    await link(c, p, actorId, daysAgo);
    let seq = 0;
    for (const [system, taskName, assignedTeam, assignedUserId, status] of tasks) {
      const start = at(goLive, 9 + Math.floor(seq / 2), (seq % 2) * 30);
      seq++;
      await prisma.task.create({
        data: {
          projectId: p.id, sequenceNumber: seq, system, taskName, assignedTeam, assignedUserId, status,
          plannedStartTime: start, plannedEndTime: new Date(start.getTime() + 30 * 60000),
          actualStartTime: status === 'Completed' ? start : null,
          actualEndTime: status === 'Completed' ? new Date(start.getTime() + 25 * 60000) : null,
        },
      });
    }
  }


  type Step2 = { system: string; name: string; team: string; owner: string; start: Date; end: Date | null; status: string; deps?: number[] };
  /** Detailed cutover plan with explicit times and dependencies (by sequence number). */
  async function plan(c: { id: string }, p: { id: string; code: string }, actorId: string, daysAgo: number, steps: Step2[]) {
    await link(c, p, actorId, daysAgo);
    const ids: string[] = [];
    for (const [i, st] of steps.entries()) {
      const done = st.status === 'Completed';
      const t = await prisma.task.create({
        data: {
          projectId: p.id, sequenceNumber: i + 1, system: st.system, taskName: st.name, assignedTeam: st.team, assignedUserId: st.owner,
          status: st.status, plannedStartTime: st.start, plannedEndTime: st.end,
          actualStartTime: done || st.status === 'Acknowledged' ? st.start : null, actualEndTime: done ? st.end ?? st.start : null,
        },
      });
      ids.push(t.id);
      for (const d of st.deps ?? []) await prisma.taskDependency.create({ data: { taskId: t.id, dependsOnTaskId: ids[d - 1]! } });
    }
  }

  const c1 = await cr({
    title: 'Nudge - WhatsApp channel for customer onboarding', product: 'Nudge', releaseType: 'Major release', priority: 'High',
    impact: 'High', risk: 'Medium', customer: 'Bluewave Finance', labels: ['whatsapp', 'onboarding'], goLive: -10,
    description: 'Add WhatsApp as a delivery channel for onboarding nudges, including template approval and opt-in handling.',
    assigneeId: priya.id, reporterId: anita.id, createdDaysAgo: 30,
    path: [
      { to: 'ASSESS', by: priya.id, daysAgo: 28 }, { to: 'SCHEDULED', by: vikram.id, daysAgo: 25 },
      { to: 'ASSESS', by: arjun.id, daysAgo: 18, msg: 'UAT: opt-out messages were not recorded. Sending back to fix before go-live.' },
      { to: 'SCHEDULED', by: vikram.id, daysAgo: 14 }, { to: 'IMPLEMENT', by: priya.id, daysAgo: 10 },
      { to: 'REVIEW', by: priya.id, daysAgo: 10 }, { to: 'CLOSED', by: anita.id, daysAgo: 8 },
    ],
  });
  const relOct = await project('REL-OCT', 'October release');
  await cutover(c1, relOct, -10, priya.id, 12, [
    ['Comms', 'Notify customer of go-live window', 'BA', rahul.id, 'Completed'],
    ['Nudge', 'Deploy Nudge v4.1', 'Dev', priya.id, 'Completed'],
    ['QA', 'Send 3 test WhatsApp nudges', 'QA', arjun.id, 'Completed'],
  ]);

  const c2 = await cr({
    title: 'Nudge - API integration for Acme Retail', product: 'Nudge', releaseType: 'Minor release', priority: 'Critical',
    impact: 'High', risk: 'Medium', customer: 'Acme Retail', labels: ['api', 'customer-go-live'], goLive: 0,
    description: 'Acme Retail sends customer events through their REST API. We enter their API details into Nudge call settings, test end-to-end, then go live.',
    assigneeId: priya.id, reporterId: anita.id, createdDaysAgo: 12,
    path: [{ to: 'ASSESS', by: priya.id, daysAgo: 11 }, { to: 'SCHEDULED', by: anita.id, daysAgo: 7 }, { to: 'IMPLEMENT', by: priya.id, daysAgo: 0.1 }],
  });
  // CR-1002 shows every cutover case: a multi-day approval, parallel tasks with
  // different owners, a dependency chain, a 0:00 checkpoint and an N/A (open) task.
  // One release project holds several change requests; its task plan is the cutover.
  const relNov = await project('REL-NOV', 'November release');
  await plan(c2, relNov, priya.id, 6, [
    { system: 'Mgmt', name: 'Management go-live approval', team: 'Management', owner: anita.id, start: at(-3, 9), end: at(0, 8), status: 'Completed' },
    { system: 'Comms', name: 'Send go-live notice to Acme and internal teams', team: 'BA', owner: rahul.id, start: at(0, 9), end: at(0, 9, 30), status: 'Completed', deps: [1] },
    { system: 'DB', name: 'Back up Nudge production database', team: 'DBA', owner: sneha.id, start: at(0, 9), end: at(0, 9, 45), status: 'Completed', deps: [1] },
    { system: 'Nudge', name: 'Enter Acme API credentials in Nudge call settings', team: 'Dev', owner: priya.id, start: at(0, 9), end: at(0, 9, 20), status: 'Completed', deps: [1] },
    { system: 'Nudge', name: 'Deploy Nudge release 4.2 to production', team: 'Dev', owner: priya.id, start: at(0, 9, 45), end: at(0, 10, 30), status: 'Acknowledged', deps: [3, 4] },
    { system: 'QA', name: 'Smoke test: trigger 5 nudges via Acme API', team: 'QA', owner: arjun.id, start: at(0, 10, 30), end: at(0, 11), status: 'Pending', deps: [5] },
    { system: 'Mgmt', name: 'Go / No-Go decision', team: 'Management', owner: vikram.id, start: at(0, 11), end: at(0, 11), status: 'Pending', deps: [6] },
    { system: 'Comms', name: 'Confirm go-live with Acme and close the window', team: 'BA', owner: rahul.id, start: at(0, 11), end: at(0, 11, 15), status: 'Pending', deps: [7] },
    { system: 'Support', name: 'Hypercare monitoring (until stable)', team: 'Support', owner: sneha.id, start: at(0, 11, 15), end: null, status: 'Pending', deps: [7] },
  ]);
  await comment(c2.id, rahul.id, 'Acme confirmed their sandbox API credentials work. Production keys shared via the vault.', 6);
  await comment(c2.id, arjun.id, 'UAT passed on the quality environment - 42/42 test cases green.', 2);
  for (const [doc, url] of [['Release Notes', 'https://example.com/release-notes/nudge-4-2'], ['Rollback Plan', 'https://example.com/runbooks/nudge-rollback']] as const) {
    await prisma.changeDocument.create({ data: { changeRequestId: c2.id, documentTypeId: await value('supporting_document', doc), url, addedById: priya.id } });
  }

  const c3 = await cr({
    title: 'Tilli-go - move email reminders to delayed jobs', product: 'Tilli-go', releaseType: 'Minor release', priority: 'Medium',
    impact: 'Medium', risk: 'Low', labels: ['email', 'worker'], goLive: 2,
    description: 'Replace polling with delayed BullMQ jobs so cutover owners get their email exactly on time.',
    assigneeId: sneha.id, reporterId: anita.id, createdDaysAgo: 9,
    path: [{ to: 'ASSESS', by: sneha.id, daysAgo: 8 }, { to: 'SCHEDULED', by: vikram.id, daysAgo: 3 }],
  });
  await link(c3, relNov, sneha.id, 3);
  await cr({
    title: 'Nudge - campaign analytics dashboard v2', product: 'Nudge', releaseType: 'Major release', priority: 'High',
    impact: 'Medium', risk: 'Medium', labels: ['analytics'], goLive: 3,
    description: 'New charts for delivery and click-through rates per campaign.', assigneeId: priya.id, reporterId: anita.id, createdDaysAgo: 5,
    path: [{ to: 'ASSESS', by: priya.id, daysAgo: 4 }],
  });
  const c5 = await cr({
    title: 'Nudge - fix SMS opt-out not saved', product: 'Nudge', changeType: 'Emergency', releaseType: 'Hotfix', priority: 'Critical',
    impact: 'High', risk: 'Low', labels: ['bug', 'sms'], goLive: 3, needsCutover: false,
    description: 'Opt-out replies from some carriers are ignored. Hotfix in the inbound SMS parser.', assigneeId: rahul.id, reporterId: anita.id, createdDaysAgo: 1,
  });
  await comment(c5.id, anita.id, 'Heads-up: this clashes with the analytics release on the same day. Can we ship the hotfix a day earlier?', 0.5);
  await cr({
    title: 'Quality System - SharePoint folder per project', product: 'Quality System', releaseType: 'Minor release', priority: 'Medium',
    impact: 'Low', risk: 'Low', labels: ['sharepoint'], goLive: 6,
    description: 'Create one SharePoint folder per test project automatically via Graph API.', assigneeId: arjun.id, reporterId: vikram.id, createdDaysAgo: 4,
    path: [{ to: 'ASSESS', by: arjun.id, daysAgo: 3 }],
  });
  await cr({
    title: 'Change Request module pilot with the Nudge team', product: 'Internal Tools', releaseType: 'Major release', priority: 'High',
    impact: 'Medium', risk: 'Low', labels: ['pilot'], goLive: 12,
    description: 'Run Nudge change requests through Tilli-go for two weeks alongside Jira, then retire the Jira board.', assigneeId: rahul.id, reporterId: vikram.id, createdDaysAgo: 0.2,
  });
  await cr({
    title: 'Nudge - retire legacy SMS gateway', product: 'Nudge', releaseType: 'Configuration', priority: 'Low',
    impact: 'Medium', risk: 'High', labels: ['cleanup'], goLive: 5,
    description: 'Switch off the old SMS provider.', assigneeId: priya.id, reporterId: anita.id, createdDaysAgo: 20,
    path: [{ to: 'ASSESS', by: priya.id, daysAgo: 19 }, { to: 'CANCELLED', by: anita.id, daysAgo: 15, msg: 'Two customers still depend on it - revisit next quarter.' }],
  });
  await cr({
    title: 'Quality System - export test report to PDF', product: 'Quality System', releaseType: 'Minor release', priority: 'Medium',
    impact: 'Low', risk: 'Low', labels: ['reports'], goLive: 9, needsCutover: false,
    description: "One-click PDF export of a project's test results for customer sign-off.", assigneeId: arjun.id, reporterId: vikram.id, createdDaysAgo: 6,
    path: [{ to: 'ASSESS', by: arjun.id, daysAgo: 5 }, { to: 'SCHEDULED', by: vikram.id, daysAgo: 2 }],
  });

  console.log(`Seeded ${await prisma.changeRequest.count()} change requests. Demo logins: priya@example.com (user), vikram@example.com (admin) - password Demo@12345`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
