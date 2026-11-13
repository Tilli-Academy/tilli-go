import React from "react";
import { statusMeta } from "./statusMeta";
import { ArrowUpRightIcon } from "./DashboardIcons";
import { useCountUp } from "./useCountUp";

// One status count. Clicking opens the task grid, exactly like the old card.
export default function KpiCard({ status, count, total, index, onClick }) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  const shown = useCountUp(count);

  return (
    <button
      type="button"
      className={`dfd-kpi df-tone-${meta.tone}`}
      style={{ "--i": index }}
      data-zero={count === 0 ? "true" : undefined}
      data-attention={status === "Blocked" && count > 0 ? "true" : undefined}
      onClick={onClick}
      aria-label={`${status}: ${count} of ${total} tasks. Open the task grid.`}
    >
      <span className="dfd-kpi-top" aria-hidden="true">
        <span className="dfd-kpi-icon">
          <Icon />
        </span>
        <span className="dfd-kpi-go">
          <ArrowUpRightIcon />
        </span>
      </span>
      <span className="dfd-kpi-value" aria-hidden="true">
        <span className="dfd-kpi-num">{shown}</span>
        <span className="dfd-kpi-of">/ {total}</span>
      </span>
      <span className="dfd-kpi-label" aria-hidden="true">
        {status}
      </span>
      <span className="dfd-kpi-hint" aria-hidden="true">
        {meta.hint}
      </span>
    </button>
  );
}
