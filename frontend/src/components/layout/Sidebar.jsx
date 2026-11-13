import React, { useEffect, useRef } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutGridIcon,
  LayersIcon,
  ListChecksIcon,
  UserIcon,
  LogOutIcon,
  ChevronLeftIcon,
} from "../dashboard/DashboardIcons";
import "./sidebar.css";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutGridIcon },
  { to: "/projects", label: "Projects", icon: LayersIcon },
  { to: "/tasks", label: "Tasks", icon: ListChecksIcon },
  { to: "/profile", label: "Profile", icon: UserIcon },
];

// Same test NavLink uses for `isActive` (case-insensitive; `end` only for /dashboard).
// Only used to place the sliding indicator; the item styles still come from NavLink.
function isNavActive(pathname, to, end) {
  const path = pathname.toLowerCase();
  const target = to.toLowerCase();
  return path === target || (!end && path.startsWith(target) && path.charAt(target.length) === "/");
}

// Brand mark: two task nodes joined by a step connector.
function BrandGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      {/* a staircase rising to an arrow: a cutover moving step by step */}
      <path
        d="M4 19.5h4.5V15H13v-4.5h3.5"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.5 5.5H20v5.5M20 5.5l-6.2 6.2"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  );
}

export default function Sidebar({ isCollapsed, isMobileOpen, onToggleCollapse, onCloseMobile }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

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
        <span className="dfs-mark" aria-hidden="true">
          <BrandGlyph />
        </span>
        <span className="dfs-wordmark">DeployFlow</span>
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
            style={{ "--dfs-i": indicatorIndex }}
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
