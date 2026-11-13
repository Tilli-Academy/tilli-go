import React from "react";
import { FolderIcon, AlertTriangleIcon, RefreshIcon } from "./DashboardIcons";

// Shown when no project is selected (same message as before).
export function DashboardEmpty() {
  return (
    <div className="dfd dfd-center">
      <div className="dfd-state" role="status">
        <div className="dfd-state-icon">
          <FolderIcon />
        </div>
        <h2>No project selected</h2>
        <p>Select a project to view the dashboard.</p>
      </div>
    </div>
  );
}

// Layout-matched placeholders while the task list loads. No fake content.
export function DashboardSkeleton() {
  return (
    <div className="dfd" aria-busy="true">
      <div className="dfd-inner">
        <div className="dfd-card dfd-skel-hero" role="status">
          <span className="dfd-loading-label">Loading dashboard...</span>
          <div className="dfd-skel dfd-skel-title" />
          <div className="dfd-skel dfd-skel-line" />
        </div>
        <div className="dfd-kpis" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="dfd-card dfd-skel-kpi">
              <div className="dfd-skel dfd-skel-icon" />
              <div className="dfd-skel dfd-skel-num" />
              <div className="dfd-skel dfd-skel-line" />
            </div>
          ))}
        </div>
        <div className="dfd-lower" aria-hidden="true">
          <div className="dfd-card dfd-skel-panel">
            <div className="dfd-skel dfd-skel-line" />
            <div className="dfd-skel dfd-skel-ring" />
          </div>
          <div className="dfd-card dfd-skel-panel">
            <div className="dfd-skel dfd-skel-line" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="dfd-skel dfd-skel-row" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Same error text and the same Retry action as before.
export function DashboardError({ error, onRetry }) {
  return (
    <div className="dfd dfd-center">
      <div className="dfd-card dfd-state dfd-state-error" role="alert">
        <div className="dfd-state-icon">
          <AlertTriangleIcon />
        </div>
        <h2>Couldn’t load the dashboard</h2>
        <p className="dfd-state-msg">Error: {error}</p>
        <button type="button" className="dfd-btn" onClick={onRetry}>
          <RefreshIcon />
          Retry
        </button>
      </div>
    </div>
  );
}
