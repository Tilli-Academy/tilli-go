import { useId, useState } from "react";
import type React from "react";
import { PieIcon } from "./DashboardIcons";
import { statusMeta } from "./statusMeta";
import type { StatusCounts } from "./statusMeta";
import type { TaskStatus } from "../../types";
import "./status-donut.css";

// Ring geometry in viewBox units (the viewBox is 200 x 200).
const CX = 100;
const R = 78;
const C = 2 * Math.PI * R;
// Surface gap between neighbouring segments, measured along the ring's centre
// line (about 2px on screen at the rendered size).
const GAP = 2.2;
// Smallest visible dash, so a very small share never vanishes into its gaps.
const MIN_DASH = 1;

const num = (n: number) => Math.round(n * 1000) / 1000;

// Visible part of a slot of length `len`, centred in the slot.
function cutSlot(len: number, gapped: boolean): { dash: number; trim: number } {
  if (!gapped) return { dash: len, trim: 0 };
  const dash = Math.max(len - GAP, Math.min(len, MIN_DASH));
  return { dash, trim: (len - dash) / 2 };
}

// Whole-percent share of the real counts. A share that is not exactly none or
// all never reads as 0% or 100%.
function formatShare(count: number, total: number): string {
  if (!total || !count) return "0%";
  const pct = (count / total) * 100;
  if (pct < 1) return "<1%";
  const whole = Math.round(pct);
  return whole === 100 && count < total ? ">99%" : `${whole}%`;
}

const taskWord = (n: number) => (n === 1 ? "task" : "tasks");

interface Segment {
  status: TaskStatus;
  count: number;
  start: number;
  len: number;
  full: boolean;
}

interface StatusDonutProps {
  counts: StatusCounts;
  total: number;
}

// Status distribution donut.
// `counts`: { Pending, Triggered, Acknowledged, Completed, Blocked } -> count.
// `total`: number of tasks. Segments exist only for counts > 0, are sized
// count / total, and run clockwise from 12 o'clock in the object's key order.
export default function StatusDonut({ counts, total }: StatusDonutProps) {
  const titleId = useId();
  const [active, setActive] = useState<TaskStatus | null>(null);

  const entries = Object.entries(counts || {}) as [TaskStatus, number][];
  const hasTasks = total > 0;

  const segments: Segment[] = [];
  let cursor = 0;
  if (hasTasks) {
    entries.forEach(([status, count]) => {
      if (!(count > 0)) return;
      const len = (count / total) * C;
      segments.push({ status, count, start: cursor, len, full: count / total >= 1 });
      cursor += len;
    });
  }
  const gapped = segments.length > 1;

  // Track underneath: one circle, cut with the same surface gaps as the
  // segments so the gaps show the card surface rather than the track.
  let trackDash: string | undefined;
  let trackOffset: number | undefined;
  if (gapped) {
    const slots = segments.map((s) => s.len);
    if (C - cursor > 0.01) slots.push(C - cursor);
    const cuts = slots.map((len) => cutSlot(len, true));
    const pattern: number[] = [];
    cuts.forEach((cut, i) => {
      const next = cuts[(i + 1) % cuts.length];
      pattern.push(cut.dash, cut.trim + (next ? next.trim : 0));
    });
    trackDash = pattern.map(num).join(" ");
    trackOffset = num(-(cuts[0]?.trim ?? 0));
  }

  const summary = `Status distribution: ${entries
    .map(([status, count]) => `${status} ${count}`)
    .join(", ")}, total ${total}`;

  const clear = () => setActive(null);

  return (
    <section
      className="dfd-card dfd-donut dfd-enter"
      style={{ "--delay": "260ms" } as React.CSSProperties}
      aria-labelledby={titleId}
    >
      <div className="dfd-card-head">
        <div>
          <h2 id={titleId} className="dfd-card-title">
            <PieIcon />
            Status distribution
          </h2>
          <p className="dfd-card-sub">Share of tasks by status</p>
        </div>
      </div>

      <div className="dfd-card-body dfd-donut-body">
        {!hasTasks ? (
          <div className="dfd-donut-empty">
            <div className="dfd-donut-figure" aria-hidden="true">
              <svg className="dfd-donut-svg" viewBox="0 0 200 200" focusable="false">
                <circle className="dfd-donut-track" cx={CX} cy={CX} r={R} fill="none" />
              </svg>
              <div className="dfd-donut-center">
                <PieIcon />
              </div>
            </div>
            <p className="dfd-donut-empty-title">No tasks to display</p>
            <p className="dfd-donut-empty-hint">
              When this project has tasks, this shows how many are in each status.
            </p>
          </div>
        ) : (
          <>
            <div className="dfd-donut-figure">
              <svg
                className="dfd-donut-svg"
                viewBox="0 0 200 200"
                role="img"
                aria-label={summary}
                focusable="false"
                data-active={active ? "" : undefined}
                style={{ "--C": num(C) } as React.CSSProperties}
              >
                <g transform={`rotate(-90 ${CX} ${CX})`} aria-hidden="true">
                  <circle
                    className="dfd-donut-track"
                    cx={CX}
                    cy={CX}
                    r={R}
                    fill="none"
                    strokeDasharray={trackDash}
                    strokeDashoffset={trackOffset}
                  />
                  <g onMouseLeave={clear}>
                    {segments.map((seg, i) => {
                      const { dash, trim } = cutSlot(seg.len, gapped);
                      const tone = statusMeta(seg.status).tone;
                      const isActive = active === seg.status;
                      return (
                        <g key={seg.status} onMouseEnter={() => setActive(seg.status)}>
                          <title>
                            {`${seg.status}: ${seg.count} ${taskWord(seg.count)} (${formatShare(seg.count, total)})`}
                          </title>
                          <circle
                            className={`dfd-donut-seg df-tone-${tone}${isActive ? " is-active" : ""}`}
                            cx={CX}
                            cy={CX}
                            r={R}
                            fill="none"
                            strokeDasharray={seg.full ? undefined : `${num(dash)} ${num(C)}`}
                            strokeDashoffset={seg.full ? undefined : num(-(seg.start + trim))}
                            style={{ "--i": i, "--len": num(seg.full ? C : dash) } as React.CSSProperties}
                          />
                          <circle
                            className="dfd-donut-hit"
                            cx={CX}
                            cy={CX}
                            r={R}
                            fill="none"
                            strokeDasharray={seg.full ? undefined : `${num(seg.len)} ${num(C)}`}
                            strokeDashoffset={seg.full ? undefined : num(-seg.start)}
                          />
                        </g>
                      );
                    })}
                  </g>
                </g>
              </svg>
              <div className="dfd-donut-center" aria-hidden="true">
                <div key={active || "__total"} className="dfd-donut-readout">
                  <span className="dfd-donut-num">{active ? counts[active] : total}</span>
                  <span className="dfd-donut-cap">{active || "Total tasks"}</span>
                </div>
              </div>
            </div>

            <ul className="dfd-donut-legend" onMouseLeave={clear}>
              {entries.map(([status, count]) => (
                <li
                  key={status}
                  className={`dfd-donut-row df-tone-${statusMeta(status).tone}${
                    active === status ? " is-active" : ""
                  }`}
                  data-zero={count === 0 ? "" : undefined}
                  onMouseEnter={() => setActive(status)}
                >
                  <span className="dfd-donut-swatch" aria-hidden="true" />
                  <span className="dfd-donut-label">{status}</span>
                  <span className="dfd-donut-count">
                    {count}
                    <span className="df-sr"> {taskWord(count)},</span>
                  </span>
                  <span className="dfd-donut-pct">{formatShare(count, total)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
