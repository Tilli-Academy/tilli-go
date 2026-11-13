import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { LayersIcon, ChevronDownIcon, CheckIcon } from "../dashboard/DashboardIcons";
import "./project-select.css";

const CLOSE_MS = 120;

// Project picker styled to match the dashboard (select-only combobox pattern).
// Same contract as the old <select>: shows the projects in the given order,
// calls onChange(projectId) only when a different project is chosen, and is
// disabled while projects load.
export default function ProjectSelect({ projects, value, onChange, loading }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const typeahead = useRef({ text: "", timer: 0 });
  const closeTimer = useRef(0);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const optionId = (i) => `${baseId}-opt-${i}`;

  const selectedIndex = projects.findIndex((p) => p.id === value);
  const selected = selectedIndex >= 0 ? projects[selectedIndex] : null;
  const disabled = loading;

  const openList = useCallback(
    (index) => {
      if (disabled || projects.length === 0) return;
      window.clearTimeout(closeTimer.current);
      setClosing(false);
      setActive(index ?? (selectedIndex >= 0 ? selectedIndex : 0));
      setOpen(true);
    },
    [disabled, projects.length, selectedIndex]
  );

  const closeList = useCallback((returnFocus = true) => {
    setClosing(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, CLOSE_MS);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const choose = (index) => {
    const project = projects[index];
    if (project && project.id !== value) onChange(project.id);
    closeList();
  };

  // Close when clicking or focusing outside.
  useEffect(() => {
    if (!open || closing) return undefined;
    const onPointer = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) closeList(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [open, closing, closeList]);

  // Keep the highlighted option in view.
  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.children[active];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Close if the list becomes unusable (e.g. projects start reloading).
  useEffect(() => {
    if (disabled && open) closeList(false);
  }, [disabled, open, closeList]);

  const jumpTo = (key) => {
    const t = typeahead.current;
    window.clearTimeout(t.timer);
    t.text += key.toLowerCase();
    t.timer = window.setTimeout(() => (t.text = ""), 600);
    const start = open && active >= 0 ? active : selectedIndex;
    const order = projects.map((_, i) => (start + 1 + i) % projects.length);
    const hit = order.find((i) => {
      const p = projects[i];
      return `${p.code}`.toLowerCase().startsWith(t.text) || `${p.name}`.toLowerCase().startsWith(t.text);
    });
    return hit === undefined ? -1 : hit;
  };

  const onKeyDown = (e) => {
    const last = projects.length - 1;
    const isOpen = open && !closing;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!isOpen) openList();
        else setActive((i) => Math.min(last, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!isOpen) openList();
        else setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        if (isOpen) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (isOpen) {
          e.preventDefault();
          setActive(last);
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (isOpen && active >= 0) choose(active);
        else openList();
        break;
      case "Escape":
        if (isOpen) {
          e.preventDefault();
          closeList();
        }
        break;
      case "Tab":
        if (isOpen) closeList(false);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
          const hit = jumpTo(e.key);
          if (hit >= 0) {
            if (isOpen) setActive(hit);
            else openList(hit);
          }
        }
    }
  };

  return (
    <div className="dfh-ps" ref={rootRef} data-open={open && !closing ? "" : undefined}>
      <span id={labelId} className="df-sr">
        Select project
      </span>
      <button
        ref={buttonRef}
        type="button"
        className="dfh-ps-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-controls={listId}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-activedescendant={open && !closing && active >= 0 ? optionId(active) : undefined}
        disabled={disabled}
        title={selected ? `${selected.code} — ${selected.name}` : undefined}
        onClick={() => (open && !closing ? closeList() : openList())}
        onKeyDown={onKeyDown}
      >
        <LayersIcon className="dfh-ps-lead" />
        <span id={valueId} className="dfh-ps-value">
          {loading ? (
            <span className="dfh-ps-placeholder">Loading projects...</span>
          ) : selected ? (
            <>
              <span className="dfh-ps-code">{selected.code}</span>
              <span className="df-sr"> — </span>
              <span className="dfh-ps-name">{selected.name}</span>
            </>
          ) : (
            <span className="dfh-ps-placeholder">Select Project</span>
          )}
        </span>
        <ChevronDownIcon className="dfh-ps-chevron" />
      </button>

      {open && (
        <div className={`dfh-ps-pop${closing ? " is-closing" : ""}`}>
          <div className="dfh-ps-heading" aria-hidden="true">
            Projects
            <span>{projects.length}</span>
          </div>
          <ul id={listId} ref={listRef} role="listbox" aria-label="Projects" className="dfh-ps-list">
            {projects.map((p, i) => {
              const isSelected = p.id === value;
              return (
                <li
                  key={p.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  className={`dfh-ps-option${i === active ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  <span className="dfh-ps-opt-code">{p.code}</span>
                  <span className="df-sr"> — </span>
                  <span className="dfh-ps-opt-name">{p.name}</span>
                  <CheckIcon className="dfh-ps-check" />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
