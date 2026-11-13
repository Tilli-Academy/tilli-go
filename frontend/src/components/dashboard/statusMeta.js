import {
  ClockIcon,
  BellIcon,
  UserCheckIcon,
  CheckCircleIcon,
  BanIcon,
} from "./DashboardIcons";

// Presentation-only details for each existing task status.
// `tone` selects the colour set from df-tokens.css; `hint` explains the
// status in plain words. Nothing here changes how statuses behave.
export const STATUS_META = {
  Pending: { tone: "pending", icon: ClockIcon, hint: "Waiting for its planned start" },
  Triggered: { tone: "triggered", icon: BellIcon, hint: "Awaiting acknowledgement" },
  Acknowledged: { tone: "acknowledged", icon: UserCheckIcon, hint: "Owner is working on it" },
  Completed: { tone: "completed", icon: CheckCircleIcon, hint: "Finished" },
  Blocked: { tone: "blocked", icon: BanIcon, hint: "Waiting on prerequisite tasks" },
};

const FALLBACK = { tone: "neutral", icon: ClockIcon, hint: "" };

export function statusMeta(status) {
  return STATUS_META[status] || FALLBACK;
}
