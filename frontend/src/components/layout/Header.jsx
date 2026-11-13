import React, { useContext } from "react";
import { useLocation, Link } from "react-router-dom";
import { ProjectContext } from "../../App";
import ProjectSelect from "./ProjectSelect";
import "./header.css";

const pageTitles = {
  "/dashboard": "Dashboard",
  "/tasks": "Task Management",
  "/projects": "Projects",
  "/profile": "Profile",
};

// Avatar initials: first two letters/digits of the email's local part ("admin@…" -> "AD").
function getInitials(email) {
  const local = String(email || "").split("@")[0];
  const chars = local.replace(/[^a-z0-9]/gi, "").slice(0, 2);
  return chars ? chars.toUpperCase() : "?";
}

function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export default function Header({ onToggleMobile }) {
  const location = useLocation();
  const title = pageTitles[location.pathname] || "DeployFlow";
  const { projects, selectedProjectId, setSelectedProjectId, projectsLoading } =
    useContext(ProjectContext);

  const user = React.useMemo(() => {
    try {
      const token = localStorage.getItem("token");
      if (!token) return null;
      const payload = JSON.parse(atob(token.split(".")[1]));
      return { email: payload.email };
    } catch {
      return null;
    }
  }, []);

  return (
    <header className="dfh h-14 flex items-center justify-between px-4 md:px-6">
      <div className="dfh-left">
        {/* Mobile menu button */}
        <button
          onClick={onToggleMobile}
          className="dfh-menu inline-flex md:hidden"
          aria-label="Toggle menu"
        >
          <MenuIcon />
        </button>
        <h1 className="dfh-title">{title}</h1>
      </div>
      <div className="dfh-right">
        <ProjectSelect
          projects={projects}
          value={selectedProjectId}
          onChange={(id) => setSelectedProjectId(id || null)}
          loading={projectsLoading}
        />
        {user && (
          <>
            <span className="dfh-divider hidden sm:block" aria-hidden="true" />
            <Link to="/profile" className="dfh-user hidden sm:flex" title={user.email}>
              <span className="dfh-avatar" aria-hidden="true">
                {getInitials(user.email)}
              </span>
              <span className="dfh-email">{user.email}</span>
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
