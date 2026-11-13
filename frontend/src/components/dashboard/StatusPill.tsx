import { statusMeta } from "./statusMeta";

interface StatusPillProps {
  status: string;
  withTip?: boolean;
}

// Status badge: icon + the exact status value. `withTip` shows the plain-words
// hint on hover/focus.
export default function StatusPill({ status, withTip = false }: StatusPillProps) {
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
