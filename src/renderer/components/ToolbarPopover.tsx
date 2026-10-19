// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React, { useEffect, useLayoutEffect, useId, useRef, useState } from "react";

/** A nonmodal toolbar disclosure, using the same surface as row action menus. */
export function ToolbarPopover({
  label,
  icon,
  children,
  menu = false,
  className = ""
}: {
  label: string;
  icon: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  menu?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const bounds = panel.current?.getBoundingClientRect();
      if (!anchor || !bounds) return;
      setPosition({
        left: Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 6, innerHeight - bounds.height - 8))
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const firstItem = panel.current?.querySelector<HTMLButtonElement>(
      "[role='menuitem']:not(:disabled)"
    );
    (firstItem ?? panel.current)?.focus();
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className={`row-action-menu toolbar-popover ${className}`} ref={root} data-compact-focus>
      <button
        ref={trigger}
        className="toolbar-button refresh-button"
        title={label}
        aria-label={label}
        aria-haspopup={menu ? "menu" : "dialog"}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          className="row-action-menu-popover toolbar-popover-panel"
          style={position}
          role={menu ? "menu" : "dialog"}
          aria-label={label}
          tabIndex={-1}
          onBlur={(event) => {
            if (!root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (!menu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const items = Array.from(
              panel.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? []
            ).filter((item) => !item.disabled);
            if (!items.length) return;
            event.preventDefault();
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
