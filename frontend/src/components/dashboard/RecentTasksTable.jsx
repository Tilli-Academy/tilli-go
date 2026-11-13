import React, { useId } from "react";
import StatusPill from "./StatusPill";
import { ActivityIcon, CalendarIcon, InboxIcon } from "./DashboardIcons";
import "./recent-tasks.css";

// Explicit table roles are intentional: the responsive CSS changes the
// display of rows and cells, which would otherwise drop table semantics.

const DATE_OPTS = { day: "numeric", month: "short", year: "numeric" };
const TIME_OPTS = { hour: "2-digit", minute: "2-digit" };

const Dash = () => <span className="dfd-tasks-none">—</span>;

// Same instant and local timezone as before; the title keeps the full string.
function PlannedStart({ value }) {
  const d = new Date(value);
  return (
    <time className="dfd-tasks-when" dateTime={value} title={d.toLocaleString()}>
      <span className="dfd-tasks-date">{d.toLocaleDateString(undefined, DATE_OPTS)}</span>{" "}
      <span className="dfd-tasks-time">{d.toLocaleTimeString(undefined, TIME_OPTS)}</span>
    </time>
  );
}

function TaskRow({ task, index }) {
  const displayId = `${task.project?.code ?? ""}-${task.sequenceNumber ?? ""}`;
  return (
    <tr role="row" className="dfd-tasks-row" style={{ "--i": index }}>
      <td role="cell" className="dfd-tasks-td dfd-tasks-c-id">
        <span className="dfd-tasks-id" title={displayId}>
          {task.project?.code}-{task.sequenceNumber}
        </span>
      </td>
      <td role="cell" className="dfd-tasks-td dfd-tasks-c-task">
        <span className="dfd-tasks-name" title={task.taskName}>
          {task.taskName}
        </span>
      </td>
      <td role="cell" className="dfd-tasks-td dfd-tasks-c-sys">
        <span className="dfd-tasks-text" title={task.system}>
          {task.system}
        </span>
      </td>
      <td role="cell" className="dfd-tasks-td dfd-tasks-c-team">
        {task.assignedTeam ? (
          <span className="dfd-tasks-text" title={task.assignedTeam}>
            {task.assignedTeam}
          </span>
        ) : (
          <Dash />
        )}
      </td>
      <td role="cell" className="dfd-tasks-td dfd-tasks-c-status">
        <StatusPill status={task.status} withTip />
      </td>
      <td role="cell" className="dfd-tasks-td dfd-tasks-c-start">
        <CalendarIcon className="dfd-tasks-when-icon" />
        {task.plannedStartTime ? <PlannedStart value={task.plannedStartTime} /> : <Dash />}
      </td>
    </tr>
  );
}

// `tasks` arrives already sorted (most recently updated first) and limited
// by the Dashboard; rows are rendered exactly as given.
export default function RecentTasksTable({ tasks = [] }) {
  const titleId = useId();

  return (
    <section
      className="dfd-card dfd-tasks dfd-enter"
      style={{ "--delay": "320ms" }}
      aria-labelledby={titleId}
    >
      <div className="dfd-card-head">
        <div>
          <h2 className="dfd-card-title" id={titleId}>
            <ActivityIcon />
            Recent tasks
          </h2>
          <p className="dfd-card-sub">Most recently updated tasks in this project</p>
        </div>
        <span className="dfd-chip">{`${tasks.length} shown`}</span>
      </div>

      <div className="dfd-tasks-scroll">
        <table className="dfd-tasks-table" role="table" aria-labelledby={titleId}>
          <colgroup>
            <col className="dfd-tasks-col-id" />
            <col />
            <col className="dfd-tasks-col-sys" />
            <col className="dfd-tasks-col-team" />
            <col className="dfd-tasks-col-status" />
            <col className="dfd-tasks-col-start" />
          </colgroup>
          <thead role="rowgroup">
            <tr role="row" className="dfd-tasks-head-row">
              <th role="columnheader" scope="col" className="dfd-tasks-th dfd-tasks-c-id">ID</th>
              <th role="columnheader" scope="col" className="dfd-tasks-th dfd-tasks-c-task">Task</th>
              <th role="columnheader" scope="col" className="dfd-tasks-th dfd-tasks-c-sys">System</th>
              <th role="columnheader" scope="col" className="dfd-tasks-th dfd-tasks-c-team">Team</th>
              <th role="columnheader" scope="col" className="dfd-tasks-th dfd-tasks-c-status">Status</th>
              <th role="columnheader" scope="col" className="dfd-tasks-th dfd-tasks-c-start">Planned start</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {tasks.map((task, index) => (
              <TaskRow key={task.id} task={task} index={index} />
            ))}
            {tasks.length === 0 && (
              <tr role="row" className="dfd-tasks-empty-row">
                <td role="cell" colSpan={6} className="dfd-tasks-empty">
                  <div className="dfd-tasks-empty-inner">
                    <span className="dfd-tasks-empty-icon">
                      <InboxIcon />
                    </span>
                    <p className="dfd-tasks-empty-text">No tasks yet. Go to Tasks to create one.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
