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
