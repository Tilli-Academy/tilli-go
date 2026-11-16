# Change Request module

Adds change requests (CR / CAB requests) to Tilli-go. A CR tracks one change from request to production.
Its optional **cutover plan is a normal Tilli-go project** (code `CR-<number>`), so the existing task grid,
dependencies, scheduler and email worker run the go-live unchanged.

## Life cycle
`New → Assess & Authorize → Scheduled → Implement → Review → Closed` (+ `Cancelled`)

| Rule | Where |
|---|---|
| Only approver roles (`CR_APPROVER_ROLES`, default `admin`) can approve Assess → Scheduled | `workflow.ts` |
| Back moves (bug found, rollback) need a reason; going back to Assess/New clears the approval | `service.ts` |
| Implement needs the cutover plan to exist (if the CR needs one) | `service.ts` |
| Review needs every cutover task Completed | `service.ts` |
| Same product + same go-live day + both open = date conflict warning | `service.ts` |

## What changed in existing code
Only wiring - existing tables and behaviour are untouched:
- `backend/prisma/schema.prisma` - 3 new models + back-relations on `User`/`Project` (no new columns on existing tables)
- `backend/prisma/migrations/20261116000000_add_change_requests` - creates the 3 new tables only
- `backend/src/routes/index.ts` - mounts `/api/change-requests`
- `frontend/src/App.tsx`, `layout/Sidebar.tsx`, `layout/Header.tsx` - routes, menu item, page titles
- `docker/` - `uploads` volume and `CR_APPROVER_ROLES` for the API

New code lives in `backend/src/modules/changeRequests/` and `frontend/src/modules/changeRequests/`.

## API (`/api/change-requests`, JWT required)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | list (`status`, `product`, `q`, `mine=1`, `conflicts=1`) + counts per status |
| GET | `/meta` | users, dropdown options, approver roles |
| GET | `/conflicts?product=&date=YYYY-MM-DD` | open CRs for that product/day |
| POST | `/` | create |
| GET | `/:id` | detail with history, attachments, conflicts, allowed transitions |
| POST | `/:id/transition` | `{ to, reason? }` |
| POST | `/:id/comments` | `{ message }` |
| POST | `/:id/cutover` | create + link the cutover project |
| POST | `/:id/attachments` | raw body, headers `X-File-Name`, `X-File-Type` (10 MB max) |
| GET | `/:id/attachments/:attachmentId` | download (only images/PDF open inline) |

## Demo data
```bash
cd backend && DATABASE_URL=... npm run db:seed:cr   # safe to re-run
```
Logins (password `Demo@12345`): `priya@example.com` (developer, role user), `vikram@example.com` / `anita@example.com` (approvers, role admin).

## Not done yet
- Attachments are stored on a Docker volume; next step is SharePoint via Microsoft Graph (same as the Quality System).
- Dropdown values in `options.ts` are placeholders until the exact Jira values are confirmed.

# Cutover planning rules + Timeline

From the cutover tracker discussion: Excel forced a grid; the web app can model the real rules.

| Rule | Behaviour |
|---|---|
| Tasks linked by a dependency | run one by one - never a clash |
| Tasks with no dependency in the same time frame | run in **parallel** - allowed only with **different owners** (same person, or same team when no person is set on either = rejected with 409) |
| Duration 0:00:00 | a **checkpoint** (e.g. Go / No-Go) - drawn as ◆ |
| No end time | **N/A / no estimate** - allowed |
| 24h or more (e.g. "get management approval") | **long-running / waiting** work - allowed, and does not block its owner |
| End before start | rejected (400) |

- Enforced in the backend (`backend/src/modules/cutover/rules.ts`) on task create/update, but **only when time, owner or dependencies change**, so the scheduler/worker's status updates are never blocked. Completed tasks are ignored.
- The Tasks grid shows the error as a toast and reverts the edit; a read-only **Duration** column shows `0:00 checkpoint`, `45 min`, `2 d`, `1 wk`, `N/A`.
- **Timeline** page (`/timeline`, also from a CR's cutover card): one lane per owner, parallel work side by side, zoom to the go-live day, click a task to see what it waits for / blocks / runs in parallel with, and any existing clashes highlighted. API: `GET /api/cutover/:projectId/timeline`.
- Open question for review: should the same **team** with **different people** be allowed in parallel? Currently yes (only same person, or same team with no person set, clash).

# Start-time alerts
Built from the "DeployFlow · Start-time alerts" mockup (first-release scope: phases 0–2).

When a task's **planned start arrives** and **everything before it is Completed**, the worker emails the owner "your task is ready to start now". The owner confirms with one click.

| Case | What happens | Alert status |
|---|---|---|
| Owner has a company address | Email from the DeployFlow mailbox, reply-to Release Management, times in IST and UTC, earlier steps listed, **Acknowledge & start** button | `SENT` → `ACKNOWLEDGED` |
| No owner set | Never guesses an address — Release Management is emailed instead | `NO_OWNER` |
| Owner address outside `ALERT_ALLOWED_DOMAINS` | Not sent — Release Management is emailed | `BLOCKED_DOMAIN` |
| Send fails | BullMQ retries (5 attempts); after the last one Release Management is told | `RETRYING` → `FAILED` |
| Due, but an earlier step isn't done | Task goes `Blocked`; alert goes out as soon as it is released | — |

- **Per-project switch** (`projects.start_alerts_enabled`). New projects start **Off**, so planning and dry runs never email anyone. The migration sets existing projects to On, so today's behaviour does not change. Completion emails follow the same switch. Only `CR_APPROVER_ROLES` (release managers) can change it.
- **One alert per task** (`task_alerts`, unique per task), every step written to the task's audit log.
- **One click to confirm**: the email link opens `/#/acknowledge`, which only *reads* (`GET /api/acknowledge/preview`). Nothing changes until the owner clicks (`POST /api/acknowledge`), so email link scanners can't acknowledge by accident. The link is signed for that task and owner and expires 12 h after the planned end. Older links (`GET /api/acknowledge`) still work.
- **Where to see it**: Timeline page → *Start-time alerts* panel (switch, counts, per-task alert status, alert history, refreshes every 10 s); task panel on the Timeline; *Start-time alert* column in the Tasks grid.
- API: `GET/PATCH /api/alerts/projects/:projectId`. Code: `worker/src/services/alertEmail.ts`, `worker/src/processors/emailProcessor.ts`, `backend/src/modules/alerts/`.
- Settings (api + worker): `ALERT_ALLOWED_DOMAINS` (default `EMAIL_DOMAIN`), `ALERT_RELEASE_MANAGER_EMAIL`, `ALERT_REPLY_TO` (default `release-management@EMAIL_DOMAIN`), `ALERT_TIMEZONE` (default `Asia/Kolkata`), `EMAIL_FROM_ADDRESS`.
- Not in this release (mockup "planned enhancement" / "later"): reminder + lead escalation after 10 min, "due but waiting" warning email, Microsoft 365 / Teams delivery.

## Live demo
- `DEMO_TOOLS=true` shows **▶ Start live rehearsal** on the alerts panel (release managers only). It rebuilds project `LIVE` timed from *now*: within ~2 minutes one owner is emailed, one task has no owner, one owner is outside the company, and one waits on `LIVE-1` — mark `LIVE-1` Completed to release it. **↻ Check now** runs the scheduler immediately instead of waiting for the next minute.
- Real emails without a real mailbox: start with `--profile mail` and set `SMTP_HOST=mailpit SMTP_PORT=1025 SMTP_USER=demo SMTP_PASS=demo`. Every email lands in the Mailpit inbox (`MAILPIT_PORT`, default 8025) and never leaves the machine.

# Import from Excel
**Import from Excel** on the Timeline uploads the "Cutover Activities" tab saved as CSV and creates a project from it (`POST /api/cutover/import?name=&code=&startAt=`, body = CSV).
- Sections (Pre-Deployment, Deployment, Post Deployment, Business Validation, Status updates), landscape → system, team, assignee (used as the owner), estimated start/end (read as US Central), status (`In-Progress` → Acknowledged, `N/A` → Completed with a note), pre-req and comments come across.
- **Reported, not hidden**: rows that end before they start (imported with no end), dates that aren't dates, durations that disagree with start/end, and owner clashes (shown on the Timeline).
- *Re-plan for a new cutover night* moves the whole plan so the first Deployment task starts at the chosen time; untick to keep the sheet's dates. Alerts stay Off for imported projects.
