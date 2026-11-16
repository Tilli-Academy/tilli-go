import prisma from '../../config/prisma';

// A short cutover plan timed from "now", for showing start-time alerts live.
// Every case from the mockup appears within ~4 minutes of pressing the button:
//   LIVE-1  running now (Acknowledged) — mark it Completed to release LIVE-2
//   LIVE-2  due in 1 min but waits on LIVE-1          → Blocked, then emailed
//   LIVE-3  due in 1 min, nothing before it           → emailed straight away
//   LIVE-4  due in 2 min, no owner                    → release manager told
//   LIVE-5  due in 2 min, owner outside the company   → not sent, manager told
//   LIVE-6  due in 4 min, waits on LIVE-2             → chain continues
const CODE = 'LIVE';

const PEOPLE = [
  { key: 'rahul', email: 'rahul@example.com', name: 'Rahul Verma' },
  { key: 'priya', email: 'priya@example.com', name: 'Priya Nair' },
  { key: 'sneha', email: 'sneha@example.com', name: 'Sneha Iyer' },
  { key: 'arjun', email: 'arjun@example.com', name: 'Arjun Mehta' },
  { key: 'partner', email: 'evon@partner-bank.example', name: 'Evon (partner bank)' },
] as const;

export async function resetLivePlan() {
  const ids: Record<string, string> = {};
  for (const p of PEOPLE) {
    const user = await prisma.user.upsert({
      where: { email: p.email },
      update: {},
      create: { email: p.email, name: p.name, role: 'user' },
    });
    ids[p.key] = user.id;
  }

  await prisma.project.deleteMany({ where: { code: CODE } });
  const min = (m: number) => new Date(Date.now() + m * 60_000);

  const project = await prisma.project.create({
    data: {
      code: CODE,
      name: 'Live cutover rehearsal',
      description: 'Timed from when it was created, to show start-time alerts firing.',
      startAlertsEnabled: true,
    },
  });

  const rows = [
    { seq: 1, system: 'SAP GW', taskName: 'Stop SAP Gateway', team: 'SAP Basis', user: 'rahul', start: -20, end: 1,
      status: 'Acknowledged', actualStart: -18, notes: 'Mark this Completed during the demo to release LIVE-2.' },
    { seq: 2, system: 'SAP S4', taskName: 'Run database migration', team: 'DBA', user: 'priya', start: 1, end: 15,
      notes: '1. Confirm the backup finished.\n2. Run the migration script.\n3. Check row counts, then mark Completed.' },
    { seq: 3, system: 'FOL', taskName: 'Deploy FOL application release 3.4', team: 'App Support', user: 'sneha', start: 1, end: 20 },
    { seq: 4, system: 'Fiserv', taskName: 'Business sign-off', team: 'Business', user: null, start: 2, end: 10 },
    { seq: 5, system: 'Fiserv', taskName: 'Enable payments integration', team: 'Payments', user: 'partner', start: 2, end: 12 },
    { seq: 6, system: 'FOL', taskName: 'Post-deploy smoke test', team: 'QA', user: 'arjun', start: 4, end: 25 },
  ];

  const taskIds: Record<number, string> = {};
  for (const r of rows) {
    const t = await prisma.task.create({
      data: {
        projectId: project.id,
        sequenceNumber: r.seq,
        system: r.system,
        taskName: r.taskName,
        assignedTeam: r.team,
        assignedUserId: r.user ? ids[r.user] : null,
        plannedStartTime: min(r.start),
        plannedEndTime: min(r.end),
        status: r.status ?? 'Pending',
        actualStartTime: r.actualStart !== undefined ? min(r.actualStart) : null,
        notes: r.notes ?? null,
      },
    });
    taskIds[r.seq] = t.id;
  }

  await prisma.taskDependency.createMany({
    data: [
      { taskId: taskIds[2]!, dependsOnTaskId: taskIds[1]! },
      { taskId: taskIds[6]!, dependsOnTaskId: taskIds[2]! },
    ],
  });

  return { id: project.id, code: project.code, name: project.name };
}
