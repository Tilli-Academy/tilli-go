import prisma from '../../config/prisma';
import { AppError } from '../../utils/errors';
import { findClashes, loadPlan, type PlanTask } from './rules';

// Import a cutover sheet saved from Excel as CSV (the "Cutover Activities" tab).
// Columns: , #, Landscape, Task Name, Pre-Req, Team, Assignee, Est. Start, Est. Complete,
//          Est. Duration, Actual Start, Actual Complete, Actual Duration, Status, Comments
// Section rows (e.g. "Deployment Activities") group the tasks that follow.
// Problems Excel can't catch (end before start, bad dates) are reported, not hidden.

export interface ImportProblem { row: number; section: string; ref: string; task: string; issue: string }
export interface ImportReport {
  project: { id: string; code: string; name: string };
  imported: number;
  skippedBlank: number;
  sections: { name: string; tasks: number }[];
  checkpoints: number;
  noEstimate: number;
  durationMismatches: number;
  problems: ImportProblem[];
  clashes: number;
  shiftedByDays: number | null;
}

/** Minimal RFC 4180 CSV parser: quoted fields, "" escapes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Dates: sheet times are US Central (CST/CDT) ─────────────────────────────
const SHEET_TZ = 'America/Chicago';

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** "7/11/24 7:00 PM", "7/1/2024", "7/2/2024 11:00", "07/02/24 7AM" → Date (Central time). */
export function parseSheetDate(raw: string): Date | null | 'bad' {
  const s = raw.replace(/[^\x20-\x7E]/g, ' ').trim();
  if (!s) return null;
  if (/^0\/0\/0/.test(s)) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (!m) return 'bad';
  const [, mo, d, y, h, mi, ap] = m;
  let year = Number(y); if (year < 100) year += 2000;
  let hour = h ? Number(h) : 0;
  if (ap) { const pm = ap.toUpperCase() === 'PM'; if (hour === 12) hour = pm ? 12 : 0; else if (pm) hour += 12; }
  const month = Number(mo), day = Number(d), minute = mi ? Number(mi) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return 'bad';
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(guess - tzOffsetMs(guess, SHEET_TZ));
}

/** "0:00:00", "03:00:00", "224:00:00" → minutes; anything else → null */
function parseDuration(raw: string): number | null {
  const m = raw.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const STATUS: Record<string, string> = {
  'completed': 'Completed', 'in-progress': 'Acknowledged', 'in progress': 'Acknowledged',
  'not started': 'Pending', '': 'Pending', 'n/a': 'Completed',
};

interface Parsed {
  row: number; section: string; ref: string; system: string; taskName: string; team: string; assignee: string;
  preReq: string; comments: string; rawStatus: string; status: string;
  start: Date | null; end: Date | null; actualStart: Date | null; actualEnd: Date | null; estMinutes: number | null;
}

export async function importCutoverSheet(csv: string, opts: { name: string; code: string; startAt?: string }): Promise<ImportReport> {
  const code = opts.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) throw new AppError('Code must be 2–20 letters, numbers or dashes', 400);
  if (!opts.name.trim()) throw new AppError('Project name is required', 400);
  if (await prisma.project.findUnique({ where: { code } })) throw new AppError(`A project with code ${code} already exists`, 409);

  const rows = parseCsv(csv.replace(/^﻿/, ''));
  const header = rows.findIndex((r) => r.some((c) => c.trim() === 'Task Name'));
  if (header < 0) throw new AppError('This does not look like a cutover sheet — no "Task Name" column found', 400);
  const cols = rows[header]!.map((c) => c.trim());
  const col = (n: string) => cols.findIndex((c) => c.toLowerCase().startsWith(n.toLowerCase()));
  const C = {
    num: col('#'), landscape: col('Landscape'), task: col('Task Name'), pre: col('Pre-Req'), team: col('Team'),
    who: col('Assignee'), estStart: col('Estimated Start'), estEnd: col('Estimated Complete'), estDur: col('Estimated Duration'),
    actStart: col('Actual Start'), actEnd: col('Actual Complete'), status: col('Status'), comments: col('Comments'),
  };
  if (C.task < 0 || C.estStart < 0) throw new AppError('Missing "Task Name" or "Estimated Start" column', 400);

  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const problems: ImportProblem[] = [];
  const parsed: Parsed[] = [];
  let section = 'Tasks';
  let skippedBlank = 0;
  let durationMismatches = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const num = cell(r, C.num), title = cell(r, C.task);
    if (num === '#') continue; // repeated header
    if (!num && title && !cell(r, C.team) && !cell(r, C.estStart)) { section = title.replace(/\s+/g, ' '); continue; }
    if (i <= header || !num) continue;
    if (!title) { skippedBlank++; continue; }

    const ref = `${section} #${num}`;
    const short = title.split('\n')[0]!.slice(0, 120);
    const date = (raw: string, label: string) => {
      const v = parseSheetDate(raw);
      if (v === 'bad') { problems.push({ row: i + 1, section, ref, task: short, issue: `${label} "${raw}" is not a date — left empty` }); return null; }
      return v;
    };
    const start = date(cell(r, C.estStart), 'Estimated start');
    let end = date(cell(r, C.estEnd), 'Estimated complete');
    if (start && end && end < start) {
      problems.push({ row: i + 1, section, ref, task: short,
        issue: `Ends before it starts (${cell(r, C.estStart)} → ${cell(r, C.estEnd)}) — imported with no end (N/A)` });
      end = null;
    }
    const estMinutes = parseDuration(cell(r, C.estDur));
    if (start && end && estMinutes !== null && estMinutes > 0 && Math.abs((end.getTime() - start.getTime()) / 60000 - estMinutes) > 1) durationMismatches++;

    const rawStatus = cell(r, C.status);
    const act = (raw: string) => { const v = parseSheetDate(raw); return v instanceof Date ? v : null; };
    parsed.push({
      row: i + 1, section, ref, system: (cell(r, C.landscape) || section).slice(0, 50), taskName: title.replace(/\s+/g, ' ').slice(0, 300),
      team: cell(r, C.team).replace(/\s+/g, ' '), assignee: cell(r, C.who).replace(/\s+/g, ' ').replace(/^`$/, ''),
      preReq: cell(r, C.pre), comments: cell(r, C.comments), rawStatus,
      status: STATUS[rawStatus.toLowerCase()] ?? 'Pending',
      start, end, actualStart: act(cell(r, C.actStart)), actualEnd: act(cell(r, C.actEnd)), estMinutes,
    });
  }
  if (parsed.length === 0) throw new AppError('No tasks found in the sheet', 400);

  // Optionally move the whole plan so the cutover night (first "Deployment" task) starts at startAt.
  let shift = 0;
  if (opts.startAt) {
    const target = new Date(opts.startAt);
    if (Number.isNaN(target.getTime())) throw new AppError('startAt is not a valid date', 400);
    const pool = parsed.filter((p) => p.start && /^deployment/i.test(p.section));
    const anchor = Math.min(...(pool.length ? pool : parsed.filter((p) => p.start)).map((p) => p.start!.getTime()));
    if (Number.isFinite(anchor)) shift = target.getTime() - anchor;
  }
  const mv = (d: Date | null) => (d ? new Date(d.getTime() + shift) : null);

  const project = await prisma.$transaction(async (tx) => {
    const p = await tx.project.create({
      data: { code, name: opts.name.trim(), description: `Imported from a cutover sheet (${parsed.length} tasks).` },
    });
    await tx.task.createMany({
      data: parsed.map((t, idx) => {
        const owner = t.assignee || t.team || null;
        const notes = [
          t.rawStatus.toUpperCase() === 'N/A' ? 'Not needed (N/A in the sheet).' : '',
          t.preReq ? `Pre-req: ${t.preReq}` : '',
          t.comments,
        ].filter(Boolean).join('\n');
        return {
          projectId: p.id,
          sequenceNumber: idx + 1,
          system: t.system,
          taskName: t.taskName,
          description: `${t.ref} · Team: ${t.team || '—'}${t.assignee ? ` · Assignee: ${t.assignee}` : ''}`,
          assignedTeam: owner,
          plannedStartTime: mv(t.start),
          plannedEndTime: mv(t.end),
          actualStartTime: t.status !== 'Pending' ? mv(t.actualStart) : null,
          actualEndTime: t.status === 'Completed' ? mv(t.actualEnd) : null,
          status: t.status,
          notes: notes || null,
        };
      }),
    });
    return p;
  }, { timeout: 30_000 });

  const { tasks, edges } = await loadPlan(project.id);
  const plan: PlanTask[] = tasks.map((t) => ({ ...t, ownerName: t.assignedUser?.name ?? t.assignedTeam }));
  const clashes = findClashes(plan, edges).length;

  const sections = new Map<string, number>();
  for (const t of parsed) sections.set(t.section, (sections.get(t.section) ?? 0) + 1);

  return {
    project: { id: project.id, code: project.code, name: project.name },
    imported: parsed.length,
    skippedBlank,
    sections: [...sections.entries()].map(([name, n]) => ({ name, tasks: n })),
    checkpoints: parsed.filter((t) => t.start && t.end && t.end.getTime() === t.start.getTime()).length,
    noEstimate: parsed.filter((t) => t.start && !t.end).length,
    durationMismatches,
    problems,
    clashes,
    shiftedByDays: shift ? Math.round(shift / 86_400_000) : null,
  };
}
