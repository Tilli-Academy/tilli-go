import React from "react";
import { statusMeta } from "./statusMeta";

// Status badge: icon + the exact status value. `withTip` shows the plain-words
// hint on hover/focus.
export default function StatusPill({ status, withTip = false }) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return (
    <span
      className={`dfd-pill df-tone-${meta.tone}${withTip && meta.hint ? " dfd-tip" : ""}`}
      data-tip={withTip && meta.hint ? meta.hint : undefined}
    >
      <Icon />
      {status}
    </span>
  );
}
