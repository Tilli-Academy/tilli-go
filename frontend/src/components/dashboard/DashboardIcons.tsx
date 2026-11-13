import React from "react";

// One icon family for the dashboard: 24px grid, 1.8 stroke, round caps.
export type IconProps = React.SVGProps<SVGSVGElement>;

function Svg({ children, strokeWidth = 1.8, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 15.5V11a5.5 5.5 0 1 1 11 0v4.5l1.5 2h-14z" />
    <path d="M10 20a2.2 2.2 0 0 0 4 0" />
  </Svg>
);

export const UserCheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9.5" cy="8" r="3.5" />
    <path d="M3.5 19.5c.6-3.2 3.1-5.2 6-5.2s5.4 2 6 5.2" />
    <path d="m15.5 11 1.9 1.9 3.6-3.9" />
  </Svg>
);

export const CheckCircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.4 12.3 2.5 2.5 4.8-5.2" />
  </Svg>
);

export const BanIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </Svg>
);

export const LayersIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z" />
    <path d="m3.5 12 8.5 4.5 8.5-4.5" />
    <path d="m3.5 16 8.5 4.5 8.5-4.5" />
  </Svg>
);

export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.3l1.8 2h7.9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Svg>
);

export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </Svg>
);

export const ListChecksIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 6.5h10M10 12h10M10 17.5h10" />
    <path d="m3.5 6.5 1.2 1.2 2.3-2.4M3.5 12l1.2 1.2 2.3-2.4M3.5 17.5l1.2 1.2 2.3-2.4" />
  </Svg>
);

export const FlagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 20.5V4.5" />
    <path d="M5 4.5h11.5l-2 3.8 2 3.7H5" />
  </Svg>
);

export const PieIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 3.6A8.5 8.5 0 1 0 20.4 13H11z" />
    <path d="M14.5 3.5a8.6 8.6 0 0 1 6 6h-6z" />
  </Svg>
);

export const ActivityIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12h4l2.5-6.5 4 13 2.5-6.5h4" />
  </Svg>
);

export const ArrowUpRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7.5 16.5 16.5 7.5M9 7.5h7.5V15" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5.5 12.5 4 4 9-9.5" />
  </Svg>
);

export const AlertTriangleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 4.3 2.9 17.2A2 2 0 0 0 4.6 20.2h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Svg>
);

export const RefreshIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.35-5.65" />
    <path d="M20 4.5v4.5h-4.5" />
  </Svg>
);

export const InboxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 13.5 6 5.5h12l2.5 8" />
    <path d="M3.5 13.5v4a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4h-5l-1.5 2.5h-4L8.5 13.5z" />
  </Svg>
);

// ── Sidebar navigation (same family: 24px grid, 1.8 stroke) ──────────────
export const LayoutGridIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6.75" height="6.75" rx="1.75" />
    <rect x="13.25" y="4" width="6.75" height="6.75" rx="1.75" />
    <rect x="4" y="13.25" width="6.75" height="6.75" rx="1.75" />
    <rect x="13.25" y="13.25" width="6.75" height="6.75" rx="1.75" />
  </Svg>
);

export const UserIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.25" r="3.75" />
    <path d="M5 19.75c.8-3.6 3.7-5.75 7-5.75s6.2 2.15 7 5.75" />
  </Svg>
);

export const LogOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10" />
    <path d="M9.5 12h10M16 8l4 4-4 4" />
  </Svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m14.75 6.5-5.5 5.5 5.5 5.5" />
  </Svg>
);
