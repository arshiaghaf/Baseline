// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React, { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronRight,
  ClockArrowDown,
  Download,
  Eye,
  EyeOff,
  MoreHorizontal,
  RefreshCcw,
  Trash2
} from "lucide-react";
import type {
  ActionState,
  RowUpdateMenuAction,
  RowActionMenuPlacement,
  RowActionMenuFloatingPosition
} from "../types";
import { actionStateLabel } from "../helpers/actionState";
import { isCompactPointerBlur } from "../helpers/focus";
import {
  rowActionMenuEstimatedWidth,
  rowActionMenuEstimatedHeight,
  rowActionMenuPopoverClassName,
  floatingRowActionMenuStyle
} from "../helpers/rowMenu";
import { useSyntheticProgress } from "../hooks/useSyntheticProgress";
import { sectionTitleLabel, hasLongVersionLabel } from "../helpers/labels";

export function UpdateActionButton({
  state,
  onAction,
  readyLabel = "Update",
  disabled = false,
  readyVariant = "filled"
}: {
  state: ActionState;
  onAction: () => void;
  readyLabel?: string;
  disabled?: boolean;
  readyVariant?: "filled" | "outline";
}) {
  if (state.type === "ready") {
    return (
      <button
        className={
          readyVariant === "outline"
            ? "primary-button outline-button update-action-button"
            : "primary-button update-action-button"
        }
        disabled={disabled}
        onClick={onAction}
      >
        {readyLabel}
      </button>
    );
  }

  const isFailure = state.type === "failed";
  return (
    <button
      className={isFailure ? "destructive-icon-button" : "update-icon-button"}
      aria-label={actionStateLabel(state)}
      title={actionStateLabel(state)}
      disabled={disabled}
      onClick={(event) => event.preventDefault()}
      tabIndex={-1}
      type="button"
    >
      {state.type === "queued" ? (
        <ClockArrowDown size={14} />
      ) : state.type === "updating" ? (
        state.progress === undefined ? (
          <RefreshCcw className="spin" size={14} />
        ) : (
          <ProgressRing value={state.progress} paused={state.waitingForAdmin} />
        )
      ) : state.type === "done" ? (
        <DoneTransitionGlyph />
      ) : (
        <span className="failure-glyph">!</span>
      )}
    </button>
  );
}

export function RowMoreActionButton({
  isIgnored,
  disabled,
  updateAction,
  onToggleIgnore,
  uninstallLabel,
  canUninstall = false,
  uninstalling = false,
  uninstallDisabled = false,
  onUninstall
}: {
  isIgnored: boolean;
  disabled?: boolean;
  updateAction?: RowUpdateMenuAction;
  onToggleIgnore: () => void;
  uninstallLabel: string;
  canUninstall?: boolean;
  uninstalling?: boolean;
  uninstallDisabled?: boolean;
  onUninstall: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuID = useId();
  const keyboardOpening = useRef<"first" | "last" | undefined>(undefined);
  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPlacement, setPopoverPlacement] = useState<RowActionMenuPlacement>("below");
  const [floatingPopoverPosition, setFloatingPopoverPosition] =
    useState<RowActionMenuFloatingPosition>();
  const ignoreLabel = isIgnored ? "Unignore" : "Ignore";

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      }
    };

    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPlacement("below");
      setFloatingPopoverPosition(undefined);
      return undefined;
    }

    const updatePopoverPlacement = () => {
      const trigger = triggerRef.current;
      const clippingContainer =
        menuRef.current?.closest(".search-palette-results") ??
        menuRef.current?.closest(".search-palette");
      if (!trigger || !(clippingContainer instanceof HTMLElement)) {
        setPopoverPlacement("below");
        setFloatingPopoverPosition(undefined);
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const clippingRect = clippingContainer.getBoundingClientRect();
      const popoverRect = popoverRef.current?.getBoundingClientRect();
      const popoverWidth = popoverRect?.width || rowActionMenuEstimatedWidth;
      const popoverHeight =
        popoverRect?.height || rowActionMenuEstimatedHeight(updateAction, canUninstall);
      const viewportPadding = 8;
      const gap = 6;
      const availableBelow = clippingRect.bottom - triggerRect.bottom - gap - viewportPadding;
      const availableAbove = triggerRect.top - clippingRect.top - gap - viewportPadding;

      if (availableBelow >= popoverHeight) {
        setPopoverPlacement("below");
        setFloatingPopoverPosition(undefined);
        return;
      }

      if (availableAbove >= popoverHeight) {
        setPopoverPlacement("above");
        setFloatingPopoverPosition(undefined);
        return;
      }

      const preferredTop =
        availableBelow >= availableAbove
          ? triggerRect.bottom + gap
          : triggerRect.top - popoverHeight - gap;
      const maxTop = Math.max(
        viewportPadding,
        window.innerHeight - popoverHeight - viewportPadding
      );
      const maxLeft = Math.max(viewportPadding, window.innerWidth - popoverWidth - viewportPadding);
      setPopoverPlacement("floating");
      setFloatingPopoverPosition({
        left: Math.min(Math.max(viewportPadding, triggerRect.right - popoverWidth), maxLeft),
        top: Math.min(Math.max(viewportPadding, preferredTop), maxTop)
      });
    };

    updatePopoverPlacement();
    window.addEventListener("resize", updatePopoverPlacement);
    window.addEventListener("scroll", updatePopoverPlacement, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPlacement);
      window.removeEventListener("scroll", updatePopoverPlacement, true);
    };
  }, [canUninstall, open, updateAction]);

  useLayoutEffect(() => {
    if (!open || !keyboardOpening.current) return;
    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ??
        []
    );
    if (popoverRef.current?.contains(document.activeElement)) return;
    (keyboardOpening.current === "last" ? items.at(-1) : items[0])?.focus();
  }, [open, popoverPlacement]);

  const invokeIgnore = () => {
    closeMenu(Boolean(keyboardOpening.current));
    onToggleIgnore();
  };

  const invokeUpdate = () => {
    if (!updateAction || updateAction.state.type !== "ready" || updateAction.disabled) {
      return;
    }

    closeMenu(Boolean(keyboardOpening.current));
    updateAction.onAction();
  };

  const invokeUninstall = () => {
    closeMenu(Boolean(keyboardOpening.current));
    onUninstall();
  };
  const isSearchPaletteRowMenu = Boolean(menuRef.current?.closest(".search-palette"));
  const popover = open ? (
    <div
      ref={popoverRef}
      id={menuID}
      onKeyDown={(event) => {
        keyboardOpening.current = "first";
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = Array.from(
          popoverRef.current?.querySelectorAll<HTMLButtonElement>(
            "[role='menuitem']:not(:disabled)"
          ) ?? []
        );
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
      className={rowActionMenuPopoverClassName(popoverPlacement)}
      data-search-palette-floating-row-menu={
        isSearchPaletteRowMenu && popoverPlacement === "floating" ? "true" : undefined
      }
      role="menu"
      style={
        popoverPlacement === "floating"
          ? floatingRowActionMenuStyle(floatingPopoverPosition)
          : undefined
      }
    >
      {updateAction && (
        <button
          onClick={invokeUpdate}
          role="menuitem"
          disabled={updateAction.disabled || updateAction.state.type !== "ready"}
        >
          {updateAction.state.type === "ready" ? (
            <Download size={14} />
          ) : updateAction.state.type === "queued" ? (
            <ClockArrowDown size={14} />
          ) : updateAction.state.type === "updating" ? (
            updateAction.state.progress === undefined ? (
              <RefreshCcw className="spin" size={14} />
            ) : (
              <ProgressRing
                value={updateAction.state.progress}
                paused={updateAction.state.waitingForAdmin}
              />
            )
          ) : updateAction.state.type === "done" ? (
            <Check className="done-glyph" size={14} strokeWidth={3} />
          ) : (
            <span className="failure-glyph">!</span>
          )}
          <span>
            {updateAction.state.type === "ready"
              ? (updateAction.readyLabel ?? "Update")
              : actionStateLabel(updateAction.state)}
          </span>
        </button>
      )}
      <button onClick={invokeIgnore} role="menuitem" disabled={disabled}>
        {isIgnored ? <EyeOff size={14} /> : <Eye size={14} />}
        <span>{ignoreLabel}</span>
      </button>
      {canUninstall && (
        <button
          className="danger-menu-item"
          onClick={invokeUninstall}
          role="menuitem"
          disabled={uninstallDisabled}
        >
          {uninstalling ? <UninstallActionGlyph /> : <Trash2 size={14} />}
          <span>{uninstallLabel}</span>
        </button>
      )}
    </div>
  ) : null;

  return (
    <div
      className="row-action-menu"
      ref={menuRef}
      onMouseDownCapture={() => {
        keyboardOpening.current = undefined;
      }}
      onBlur={(event) => {
        // Compact pointer focus clearing must not remove the click target
        // between mousedown and click. Outside presses dismiss separately.
        if (isCompactPointerBlur(event.target)) return;
        const next = event.relatedTarget as Node | null;
        if (open && !menuRef.current?.contains(next) && !popoverRef.current?.contains(next)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        className="secondary-icon-button"
        disabled={disabled}
        onClick={(event) => {
          keyboardOpening.current = event.detail === 0 ? "first" : undefined;
          setOpen((isOpen) => !isOpen);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          keyboardOpening.current = event.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
          if (open) {
            const items = popoverRef.current?.querySelectorAll<HTMLButtonElement>(
              "[role='menuitem']:not(:disabled)"
            );
            (event.key === "ArrowUp" ? items?.[items.length - 1] : items?.[0])?.focus();
          }
        }}
        title="Actions"
        aria-label="Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuID : undefined}
      >
        {uninstalling ? <UninstallActionGlyph /> : <MoreHorizontal size={15} />}
      </button>
      {popoverPlacement === "floating" && popover ? createPortal(popover, document.body) : popover}
    </div>
  );
}

export function ProgressRing({ value, paused = false }: { value: number; paused?: boolean }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const progress = useSyntheticProgress(value, paused);
  return (
    <svg className="progress-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="progress-ring-track" cx="8" cy="8" r={radius} />
      <circle
        className="progress-ring-value"
        cx="8"
        cy="8"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
      />
    </svg>
  );
}

export function DoneTransitionGlyph() {
  return <Check className="done-glyph" size={15} strokeWidth={3} />;
}

export function UninstallActionGlyph() {
  return <Trash2 className="uninstall-glyph" size={15} />;
}

export function PanelTitle({
  title,
  action,
  canCollapse = false,
  collapsed = false,
  onToggleCollapse
}: {
  title: string;
  action?: React.ReactNode;
  canCollapse?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const label = sectionTitleLabel(title);
  return (
    <div className="panel-title">
      {canCollapse ? (
        <button
          className="section-toggle"
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
          title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
        >
          <span>{label}</span>
          <ChevronRight size={13} className={collapsed ? "" : "expanded"} />
        </button>
      ) : (
        <h2>{label}</h2>
      )}
      {action}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

export function VersionChange({
  from,
  to,
  collapseLong = false
}: {
  from: string;
  to: string;
  collapseLong?: boolean;
}) {
  if (collapseLong && hasLongVersionLabel(from, to)) {
    return (
      <span className="version-token" title={`${from} → ${to}`}>
        {to}
      </span>
    );
  }

  return (
    <>
      <span className="version-token">{from}</span>
      <span className="version-arrow">→</span>
      <span className="version-token">{to}</span>
    </>
  );
}
