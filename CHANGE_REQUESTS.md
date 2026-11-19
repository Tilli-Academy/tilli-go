# Change Request module

Adds change requests (CR / CAB requests) to Tilli-go. A CR tracks one change from request to production.
A CR **belongs to a project** (e.g. a release or wave); one project can group several CRs. The project
**owns the optional cutover**: its task plan. So the existing task grid, dependencies, scheduler and email
worker run the go-live unchanged. A CR picks or creates its project (from its page or when it is raised) and
can change project until implementation starts. Projects created earlier as `CR-<number>` stay as ordinary
projects holding their CR; no data was moved.

## Life cycle
`New → Assess & Authorize → Scheduled → Implement → Review → Closed` (+ `Cancelled`)

Leaving **Assess** is a CAB decision (approver only, `cr.decide`):

| Decision | Effect |
|---|---|
| Approved | → Scheduled; sets Date Approved and Approved By. Blocked until every *required* supporting document is attached |
| Request more info | → back to New, reason required, clears any approval |
| Deferred | stays in Assess, moved to a later Date Presented |
| Rejected | → Closed (Rejected), reason required |

| Rule | Where |
|---|---|
| Each move needs a permission (submit/implement/review: `cr.edit`; close/cancel/withdraw: `cr.close`) | `workflow.ts` |
| Back moves (bug found, rollback) need a reason; going back to Assess clears the approval | `service.ts` |
| "Bug found - back to Assess" only by the CR's assignee, its reporter or an approver (until the Roles page) | `workflow.ts`, `service.ts` |
| Deployment date is locked once approved (send the CR back to change it) | `service.ts` |
| Implement needs a plan (if the CR needs a cutover): a project with at least one task | `service.ts` |
| Review needs the CR's own tasks done (tasks tagged with the CR in the grid), or, if none are tagged, every task in the project's plan. Done = Completed or N/A | `service.ts` |
| Open CRs sharing a product on the same go-live day = date conflict warning | `service.ts` |

## Fields
Title, description, **products** (several), change type, release type, team, priority, risk and impact
(Low / Medium / High), customer, labels, **deployment date and time** (typed and shown in the project's zone; same-day conflicts use that zone's calendar day), **code freeze date**, **date presented** (CAB),
**downtime (hours)**, due date, assignee, reporter, project. Set automatically: decision, Date Approved,
Approved By. Plus a **supporting-documents checklist** (each item links to an attachment of the CR or a URL)
and **linked change requests** (shown on both).

## Managed lists (Admin → Lists, `admin.lists`)
Change type, release type, products, priority, team and supporting documents are rows in `list_values` with
stable ids: add, rename, recolour, reorder, deactivate. A value in use is never deleted: deactivate it and it
stays on old CRs but leaves the pickers. Risk and decision have fixed keys (rules depend on them), so only their
labels and colours change. A supporting document can be marked **required** (needed before approval).
The migration created the standard values and turned the values already used by CRs into rows; replaced ones
(e.g. "Normal", "Hotfix") are inactive. Products and teams start empty on a new install.

## Permissions
The API checks permissions, never role names. `role_permissions` maps roles to permissions (seeded by the
migration; a Roles page will edit it in a follow-up PR). Replaces `CR_APPROVER_ROLES`.

| Permission | Allows | admin | user |
|---|---|---|---|
| `cr.create` | raise a change request | ✓ | ✓ |
| `cr.edit` | edit, attach, link, documents, pick a project, move along the workflow | ✓ | ✓ |
| `cr.decide` | CAB decision | ✓ | |
| `cr.close` | close, cancel, withdraw | ✓ | |
| `cutover.manage` | start-time alerts switch, live rehearsal, run the scheduler now | ✓ | |
| `task.edit` | create and edit tasks | ✓ | ✓ |
| `task.delete` | delete tasks | ✓ | |
| `project.manage` | create, edit, delete projects | ✓ | |
| `admin.lists` | Admin → Lists | ✓ | |

`GET /api/auth/permissions` returns the signed-in user's permissions (the UI hides what they can't do).

## API (`/api/change-requests`, JWT required)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | list (`status`, `product` = product id, `project`, `q`, `mine=1`, `conflicts=1`) + counts per status |
| GET | `/meta` | users, the caller's permissions, approver roles |
| GET | `/conflicts?products=id1,id2&date=YYYY-MM-DD` | open CRs sharing a product that day |
| POST | `/` | create (`cr.create`) |
| GET | `/:id` | detail with history, attachments, documents, links, conflicts, allowed moves |
| PATCH | `/:id` | edit fields (`cr.edit`) |
| POST | `/:id/transition` | `{ to, reason? }` |
| POST | `/:id/decision` | `{ decision, reason?, datePresented? }` (`cr.decide`) |
| POST | `/:id/comments` | `{ message }` |
| PUT | `/:id/project` | `{ projectId }` (null = none) or `{ create: { name, code, timeZone } }`; locked from Implement on |
| PUT / DELETE | `/:id/documents/:typeId` | `{ attachmentId }` or `{ url }` |
| POST / DELETE | `/:id/links`, `/:id/links/:otherId` | `{ number }` |
| POST | `/:id/attachments` | raw body, headers `X-File-Name`, `X-File-Type` (10 MB max) |
| GET | `/:id/attachments/:attachmentId` | download (only images/PDF open inline) |

Lists: `GET /api/lists` (active; `?all=1` everything + usage for admins), `POST /api/lists/:list`,
`PATCH /api/lists/values/:id`, `PUT /api/lists/:list/order`, `DELETE /api/lists/values/:id` (unused only).

## Demo data
```bash
cd backend && DATABASE_URL=... npm run db:seed:cr   # safe to re-run (from a checkout with dev dependencies)
docker compose exec api npm run db:seed:cr:built    # the same, inside the running API container
```
Logins (password `Demo@12345`): `priya@example.com` (developer, role user), `vikram@example.com` / `anita@example.com` (approvers, role admin).

## Not done yet
- Attachments are stored on a Docker volume; next step is SharePoint via Microsoft Graph.
- Backup owner per task, and making the no-owner reminder interval an Admin setting (follow-up PR).

# Cutover planning rules + Timeline

From the cutover tracker discussion: Excel forced a grid; the web app can model the real rules.

| Rule | Behaviour |
|---|---|
| Tasks linked by a dependency | run one by one - never a clash |
| Tasks with no dependency in the same time frame | run in **parallel** - allowed only with **different people** (same person = rejected with 409; team text is not compared) |
| Duration 0:00:00 | a **checkpoint** (e.g. Go / No-Go) - drawn as ◆ |
| No end time | **no estimate** - allowed |
| Status **N/A** | not needed in this cutover: counts as done for every task that depends on it (API, scheduler, worker and acknowledge checks) and is locked like Completed. Can be set until the task is started |
| 24h or more (e.g. "get management approval") | **long-running / waiting** work - allowed, and does not block its owner |
| End before start | rejected (400) |

- Enforced in the backend (`backend/src/modules/cutover/rules.ts`) on task create/update, but **only when time, owner or dependencies change**, so the scheduler/worker's status updates are never blocked. Completed tasks are ignored.
- The Tasks grid shows the error as a toast and reverts the edit; a read-only **Duration** column shows `0:00 checkpoint`, `45 min`, `2 d`, `1 wk`, `N/A`.
- **Times** in the Tasks grid, Dashboard, Timeline, emails and confirm pages are in the project's zone; column headers name it (e.g. `Planned Start (CT)`) and times typed in the grid are read in it, whatever the browser's zone.
- **Task → CR tag** (optional `changeRequestId`, same project only): the grid's *Change request* column. A CR with tagged tasks only waits for those at Review, so an emergency change isn't blocked by a whole release.
- **Timeline** page (`/timeline`, also from a CR's cutover card): one lane per owner or per system (switch), parallel work side by side, zoom to the go-live day, click a task to see what it waits for / blocks / runs in parallel with, and any existing clashes highlighted. API: `GET /api/cutover/:projectId/timeline`.
- Two different people from the same team can work in parallel (reviewer decision).

# Start-time alerts
Built from the start-time alerts mockup (first-release scope: phases 0–2).

When a task's **planned start arrives** and **everything before it is Completed**, the worker emails the owner "your task is ready to start now". The owner confirms with one click.

| Case | What happens | Alert status |
|---|---|---|
| Owner has a company address | Email from the Tilli-go mailbox, reply-to Release Management, times in the project's timezone and UTC, earlier steps listed, **Acknowledge & start** button | `SENT` → `ACKNOWLEDGED` |
| No owner set | The task **does not start**: it stays Pending (on hold) and Release Management is emailed, plus **one reminder 15 min later** if still nobody is assigned (no reminder once someone is). It starts on the next scheduler run after someone is assigned. The API also refuses to move a task with no owner to Triggered/Acknowledged. | `NO_OWNER` |
| Owner changed after the alert went out | If the task is ready (Triggered) and alerts are on, the **new owner is emailed**. One alert per task per owner: nobody gets the same alert twice (`task_alerts.notified_user_ids`) | `SENT` |
| Owner address outside `ALERT_ALLOWED_DOMAINS` | Not sent — Release Management is emailed | `BLOCKED_DOMAIN` |
| Send fails | BullMQ retries (5 attempts); after the last one Release Management is told | `RETRYING` → `FAILED` |
| Due, but an earlier step isn't done | Task goes `Blocked`; alert goes out as soon as it is released | — |

- **Per-project switch** (`projects.start_alerts_enabled`). New projects start **Off**, so planning and dry runs never email anyone. The migration sets existing projects to On, so today's behaviour does not change. Completion emails follow the same switch. Changing it needs `cutover.manage`.
- **One alert per task per owner** (`task_alerts`), every step written to the task's audit log.
- **One click to confirm**: the email link opens `/#/acknowledge`, which only *reads* (`GET /api/acknowledge/preview`). Nothing changes until the owner clicks (`POST /api/acknowledge`), so email link scanners can't acknowledge by accident. The link is signed for that task and owner and expires 12 h after the planned end. A plain `GET /api/acknowledge` is read-only too. After the task is reassigned, the previous owner's link is refused (403).
- **Completion link**: same pattern. `/#/complete` reads (`GET /api/complete/preview`), and only the click completes (`POST /api/complete`). The link names the current owner and expires 12 h after the planned end; links for anyone else, or without an owner, are refused.
- **Where to see it**: Timeline page → *Start-time alerts* panel (switch, counts, per-task alert status, alert history, refreshes every 10 s); task panel on the Timeline; *Start-time alert* column in the Tasks grid.
- API: `GET/PATCH /api/alerts/projects/:projectId`. Code: `worker/src/services/alertEmail.ts`, `worker/src/processors/emailProcessor.ts`, `backend/src/modules/alerts/`.
- **Timezone per project** (`projects.time_zone`, IANA name, default `America/Chicago`). The email, the acknowledge page and the Timeline show times in that zone with UTC alongside. Set it on create (`timeZone`) or with `PATCH /api/projects/:id`.
- Settings (worker only — it is the one that sends): `ALERT_ALLOWED_DOMAINS` (default `EMAIL_DOMAIN`), `ALERT_RELEASE_MANAGER_EMAIL`, `ALERT_REPLY_TO` (default `release-management@EMAIL_DOMAIN`), `EMAIL_FROM_ADDRESS` (default `noreply@EMAIL_DOMAIN`; with Microsoft 365 the sender is `MICROSOFT_MAIL_FROM`). The worker publishes the values it really uses to Redis and the alerts panel shows those, so the UI always matches the real sender.
- Not in this release: lead escalation, "due but waiting" warning email, Teams messages.

## Live demo
- `DEMO_TOOLS=true` shows **▶ Start live rehearsal** on the alerts panel (release managers only). It rebuilds project `LIVE` timed from *now*: within ~2 minutes one owner is emailed, one task has no owner, one owner is outside the company, and one waits on `LIVE-1` — mark `LIVE-1` Completed to release it. **↻ Check now** runs the scheduler immediately instead of waiting for the next minute.
- Real emails without a real mailbox: start with `--profile mail` and set `SMTP_HOST=mailpit SMTP_PORT=1025 SMTP_USER=demo SMTP_PASS=demo`. Every email lands in the Mailpit inbox (`MAILPIT_PORT`, default 8025) and never leaves the machine.
- **Demo users are `@example.com`.** To see owner emails (instead of everything going to Release Management) set `ALERT_ALLOWED_DOMAINS=tilli.pro,example.com` for the demo. The seed deliberately doesn't use the company domain, so a demo can never email a real colleague.

