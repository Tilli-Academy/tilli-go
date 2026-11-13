import React, { useContext, useRef } from "react";
import { useTaskData } from "../../hooks/useTaskData";
import { useNavigate } from "react-router-dom";
import { ProjectContext } from "../../App";
import "./dashboard.css";
import ProjectSummary from "./ProjectSummary";
import KpiCard from "./KpiCard";
import StatusDonut from "./StatusDonut";
import RecentTasksTable from "./RecentTasksTable";
import { DashboardEmpty, DashboardSkeleton, DashboardError } from "./DashboardStates";

export default function Dashboard() {
  const { selectedProjectId, projects } = useContext(ProjectContext);
  const { tasks, loading, error, fetchTasks } = useTaskData(selectedProjectId);
  const navigate = useNavigate();
  // After the first successful render, a reload (e.g. switching project) keeps
  // the current view on screen, dimmed, instead of blanking the whole page.
  const hasRendered = useRef(false);

  if (!selectedProjectId) {
    return <DashboardEmpty />;
  }

  if (loading && !hasRendered.current) {
    return <DashboardSkeleton />;
  }

  if (error) {
    return <DashboardError error={error} onRetry={fetchTasks} />;
  }

  const counts = {
    Pending: 0,
    Triggered: 0,
    Acknowledged: 0,
    Completed: 0,
    Blocked: 0,
  };
  tasks.forEach((t) => {
    if (counts[t.status] !== undefined) counts[t.status]++;
  });

  const recentTasks = [...tasks]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
    .slice(0, 8);

  // The overview card always describes the project the shown tasks belong to,
  // so name and numbers never disagree while another project is loading.
  const dataProjectId = tasks[0]?.projectId || selectedProjectId;
  const refreshing = loading || dataProjectId !== selectedProjectId;
  const project =
    (projects || []).find((p) => p.id === dataProjectId) || tasks[0]?.project || null;
  if (!loading) hasRendered.current = true;

  return (
    <div className="dfd" data-refreshing={refreshing ? "" : undefined} aria-busy={refreshing || undefined}>
      <div className="dfd-inner">
        <ProjectSummary project={project} tasks={tasks} counts={counts} />

        <section className="dfd-kpis" aria-label="Tasks by status">
          {Object.entries(counts).map(([status, count], index) => (
            <KpiCard
              key={status}
              status={status}
              count={count}
              total={tasks.length}
              index={index}
              onClick={() => navigate("/tasks")}
            />
          ))}
        </section>

        <div className="dfd-lower">
          <StatusDonut counts={counts} total={tasks.length} />
          <RecentTasksTable tasks={recentTasks} />
        </div>
      </div>
    </div>
  );
}
