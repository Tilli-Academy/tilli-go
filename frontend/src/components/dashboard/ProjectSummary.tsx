import { LayersIcon, ListChecksIcon, FlagIcon, CalendarIcon } from "./DashboardIcons";
import type { Task, TaskProjectRef, Project } from "../../types";
import type { StatusCounts } from "./statusMeta";

const formatWhen = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

// Earliest planned start to latest planned end of the loaded tasks.
function plannedWindow(tasks: Task[]): { from: number; to: number } | null {
  const times = (key: "plannedStartTime" | "plannedEndTime") =>
    tasks
      .map((t) => t[key])
      .filter((v): v is string => Boolean(v))
      .map((v) => new Date(v).getTime())
      .filter((n) => !Number.isNaN(n));
  const starts = times("plannedStartTime");
  if (starts.length === 0) return null;
  const ends = times("plannedEndTime");
  return { from: Math.min(...starts), to: Math.max(...(ends.length ? ends : starts)) };
}

interface ProjectSummaryProps {
  project: Project | TaskProjectRef | null;
  tasks: Task[];
  counts: StatusCounts;
}

// Project context + progress, built only from the project record and the
// same task list the rest of the dashboard uses.
export default function ProjectSummary({ project, tasks, counts }: ProjectSummaryProps) {
  const total = tasks.length;
  const done = counts.Completed;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const plan = plannedWindow(tasks);
  const description = project && "description" in project ? project.description : null;

  return (
    <section className="dfd-card dfd-hero dfd-enter" aria-label="Project overview">
      <div className="dfd-hero-id">
        <div className="dfd-eyebrow">
          <LayersIcon />
          Overview
        </div>
        <h2 className="dfd-hero-title">
          <span>{project?.name || "Selected project"}</span>
          {project?.code && <span className="dfd-code">{project.code}</span>}
        </h2>
        {description && (
          <p className="dfd-hero-desc" title={description}>
            {description}
          </p>
        )}
      </div>

      <div className="dfd-hero-stats">
        <div className="dfd-stat">
          <span className="dfd-stat-label">
            <ListChecksIcon />
            Total tasks
          </span>
          <span className="dfd-stat-value">{total}</span>
        </div>

        <div className="dfd-stat">
          <span className="dfd-stat-label">
            <FlagIcon />
            Completed
          </span>
          <span className="dfd-stat-value">
            {done}
            <small>of {total}</small>
          </span>
          <span
            className="dfd-progress"
            role="progressbar"
            aria-label="Tasks completed"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={`${done} of ${total} tasks completed`}
          >
            <span style={{ width: `${pct}%` }} />
          </span>
        </div>

        {plan && (
          <div className="dfd-stat">
            <span className="dfd-stat-label">
              <CalendarIcon />
              Planned window
            </span>
            <span className="dfd-stat-window">
              {formatWhen(plan.from)}
              <span>to {formatWhen(plan.to)}</span>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
