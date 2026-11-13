import type React from "react";
import type { TaskStatus } from "../../types";
import {
  ClockIcon,
  BellIcon,
  UserCheckIcon,
  CheckCircleIcon,
  BanIcon,
} from "./DashboardIcons";
import type { IconProps } from "./DashboardIcons";

export type StatusTone =
  | "pending"
  | "triggered"
  | "acknowledged"
  | "completed"
  | "blocked"
  | "neutral";

export interface StatusMetaEntry {
  tone: StatusTone;
  icon: (p: IconProps) => React.ReactElement;
  hint: string;
}

// Presentation-only details for each existing task status.
// `tone` selects the colour set from df-tokens.css; `hint` explains the
// status in plain words. Nothing here changes how statuses behave.
export const STATUS_META: Record<TaskStatus, StatusMetaEntry> = {
  Pending: { tone: "pending", icon: ClockIcon, hint: "Waiting for its planned start" },
  Triggered: { tone: "triggered", icon: BellIcon, hint: "Awaiting acknowledgement" },
  Acknowledged: { tone: "acknowledged", icon: UserCheckIcon, hint: "Owner is working on it" },
  Completed: { tone: "completed", icon: CheckCircleIcon, hint: "Finished" },
  Blocked: { tone: "blocked", icon: BanIcon, hint: "Waiting on prerequisite tasks" },
};

const FALLBACK: StatusMetaEntry = { tone: "neutral", icon: ClockIcon, hint: "" };

export function statusMeta(status: string): StatusMetaEntry {
  return (STATUS_META as Record<string, StatusMetaEntry | undefined>)[status] ?? FALLBACK;
}

export type StatusCounts = Record<TaskStatus, number>;
