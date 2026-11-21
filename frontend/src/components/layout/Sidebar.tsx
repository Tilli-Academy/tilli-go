import { useEffect, useRef } from "react";
import type React from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutGridIcon,
  FlagIcon,
  CalendarIcon,
  UserIcon,
  LogOutIcon,
  ChevronLeftIcon,
  SettingsIcon,
} from "../dashboard/DashboardIcons";
import type { IconProps } from "../dashboard/DashboardIcons";
import "./sidebar.css";
import tilliLogo from "../../assets/tilli-logo.png";
import { usePermissions } from "../../hooks/usePermissions";

interface NavItem {
  to: string;
  label: string;
  icon: (p: IconProps) => React.ReactElement;
}

const baseItems: NavItem[] = [
  // Change requests are the top level; a CR's tasks are opened from the CR itself.
  { to: "/change-requests", label: "Change Requests", icon: FlagIcon },
  { to: "/timeline", label: "Timeline", icon: CalendarIcon },
  { to: "/dashboard", label: "Dashboard", icon: LayoutGridIcon },
  { to: "/profile", label: "Profile", icon: UserIcon },
];
// Shown only to users with an admin permission.
const adminItem: NavItem = { to: "/admin", label: "Admin", icon: SettingsIcon };

// Same test NavLink uses for `isActive` (case-insensitive; `end` only for /dashboard).
// Only used to place the sliding indicator; the item styles still come from NavLink.
function isNavActive(pathname: string, to: string, end: boolean): boolean {
  const path = pathname.toLowerCase();
  const target = to.toLowerCase();
  return path === target || (!end && path.startsWith(target) && path.charAt(target.length) === "/");
}

interface SidebarProps {
  isCollapsed: boolean;
  isMobileOpen: boolean;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
}

export default function Sidebar({ isCollapsed, isMobileOpen, onToggleCollapse, onCloseMobile }: SidebarProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { can } = usePermissions();
  const navItems = can("admin.lists") ? [...baseItems, adminItem] : baseItems;

  const activeIndex = navItems.findIndex((item) =>
    isNavActive(pathname, item.to, item.to === "/dashboard")
  );
  // While no item is active the indicator fades out where it was instead of sliding away.
  const lastIndex = useRef(Math.max(activeIndex, 0));
  useEffect(() => {
    if (activeIndex >= 0) lastIndex.current = activeIndex;
  }, [activeIndex]);
  const indicatorIndex = activeIndex >= 0 ? activeIndex : lastIndex.current;

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("selectedProjectId");
    navigate("/login");
  };

  return (
    <aside
      className={`
        dfs flex flex-col
        ${isCollapsed ? "w-16" : "w-56"}
        md:relative md:translate-x-0
        fixed inset-y-0 left-0 z-30
        ${isMobileOpen ? "translate-x-0" : "-translate-x-full"}
      `}
      data-collapsed={isCollapsed ? "" : undefined}
      data-open={isMobileOpen ? "" : undefined}
    >
      {/* Brand + Desktop Toggle */}
      <div className="dfs-brand h-14">
        {/* the official Tilli mark: the left part of the logo image, never redrawn */}
        <span className="dfs-mark" aria-hidden="true" style={{ backgroundImage: `url(${tilliLogo})` }} />
        <span className="dfs-wordmark">Tilli-go</span>
        <button
          onClick={onToggleCollapse}
          className="dfs-toggle hidden md:flex"
          aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          data-tip={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronLeftIcon />
        </button>
      </div>

      {/* Navigation */}
      <nav aria-label="Main navigation" className="dfs-nav">
        <div className="dfs-section" aria-hidden="true">
          Menu
        </div>
        <div className="dfs-list">
          <span
            className="dfs-indicator"
            aria-hidden="true"
            data-hidden={activeIndex < 0 ? "" : undefined}
            style={{ "--dfs-i": indicatorIndex } as React.CSSProperties}
          />
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/dashboard"}
              onClick={onCloseMobile}
              className={({ isActive }) => `dfs-item${isActive ? " dfs-item-active" : ""}`}
              title={isCollapsed ? item.label : undefined}
              data-tip={item.label}
            >
              <item.icon className="dfs-icon" />
              <span className="dfs-label">{item.label}</span>
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Logout */}
      <div className="dfs-footer">
        <button
          onClick={handleLogout}
          className="dfs-item dfs-logout"
          title={isCollapsed ? "Logout" : undefined}
          data-tip="Logout"
        >
          <LogOutIcon className="dfs-icon" />
          <span className="dfs-label">Logout</span>
        </button>
      </div>
    </aside>
  );
}
