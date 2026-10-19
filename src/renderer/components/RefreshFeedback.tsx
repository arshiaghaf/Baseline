// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import { AlertTriangle, ChevronDown, Info, RefreshCcw } from "lucide-react";
import type { BaselineSnapshot } from "../../shared/domain";
import { baseline } from "../ipc";
import { toolbarIconStrokeWidth } from "../constants";
import { appCheckLabel } from "../helpers/appChecks";
import { ToolbarPopover } from "./ToolbarPopover";

export function RefreshFeedback({ snapshot }: { snapshot: BaselineSnapshot }) {
  const message = snapshot.refreshErrorMessage || snapshot.lastRefreshNoticeMessage;
  return message ? (
    <div className={`notice${snapshot.refreshErrorMessage ? " danger" : ""}`} role="status">
      <AlertTriangle size={15} />
      <span>{message}</span>
    </div>
  ) : null;
}

export function UpdateCheckStatus({ snapshot }: { snapshot: BaselineSnapshot }) {
  const checks = Object.entries(snapshot.appProviderChecks ?? {}).filter(
    ([, check]) => check.status !== "checked"
  );
  if (!checks.length) return null;
  const failed = checks.filter(([, check]) => check.status === "failed").length;
  const pending = checks.filter(([, check]) => check.status === "pending").length;
  const unresolved = checks.filter(([, check]) => check.status === "unresolved").length;
  const summary = [
    failed && `${failed} ${failed === 1 ? "check" : "checks"} failed`,
    pending && `${pending} ${pending === 1 ? "app" : "apps"} checking`,
    unresolved && `${unresolved} without a verified source`
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <>
      <span className="visually-hidden" role="status">
        Update checks: {summary}.
      </span>
      <ToolbarPopover
        label="Update check details"
        className={failed ? "update-check-status has-failures" : "update-check-status"}
        icon={failed ? <AlertTriangle size={16} /> : <Info size={16} />}
      >
        {(close) => (
          <>
            <div className="update-check-heading">
              <strong>Update checks</strong>
              {failed > 0 && (
                <p>
                  {failed} {failed === 1 ? "check" : "checks"} failed. Previous results may still
                  appear.
                </p>
              )}
              {pending > 0 && (
                <p>
                  Checking {pending} {pending === 1 ? "app" : "apps"}. Results are incomplete.
                </p>
              )}
              {unresolved > 0 && (
                <p>
                  {unresolved} {unresolved === 1 ? "app has" : "apps have"} no verified update
                  source. These apps may still have updates.
                </p>
              )}
            </div>
            <ul className="update-check-list">
              {checks.map(([id, check]) => (
                <li key={id}>
                  <strong>
                    {snapshot.apps.find((app) => app.id === id)?.displayName ?? "Unavailable app"}
                  </strong>
                  <span>{appCheckLabel(check)}</span>
                  {check.checkedAt && check.status === "failed" && (
                    <span>Last successful check: {new Date(check.checkedAt).toLocaleString()}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="update-check-footer">
              <p>Refresh retries failed checks and searches apps without a verified source.</p>
              <button
                className="ghost-button"
                disabled={snapshot.isRefreshing || snapshot.isHomebrewCleanupLocked}
                onClick={() => {
                  close();
                  void baseline.refresh(false);
                }}
              >
                Retry checks
              </button>
            </div>
          </>
        )}
      </ToolbarPopover>
    </>
  );
}

export function RefreshControl({
  snapshot,
  compact = false
}: {
  snapshot: BaselineSnapshot;
  compact?: boolean;
}) {
  const disabled = snapshot.isRefreshing || snapshot.isHomebrewCleanupLocked;
  return (
    <div className="refresh-control">
      <button
        className="toolbar-button refresh-button"
        onClick={() => void baseline.refresh(false)}
        title="Refresh"
        tabIndex={compact ? -1 : undefined}
      >
        <RefreshCcw
          className={snapshot.isRefreshing ? "spin" : undefined}
          size={16}
          strokeWidth={toolbarIconStrokeWidth}
        />
      </button>
      <ToolbarPopover label="Refresh options" icon={<ChevronDown size={12} />} menu>
        {(close) => (
          <button
            role="menuitem"
            disabled={disabled}
            title="Search all app update sources, including alternatives for apps with a known source."
            onClick={() => {
              close();
              void baseline.refresh(false, true);
            }}
          >
            <RefreshCcw size={14} />
            <span>Search sources again</span>
          </button>
        )}
      </ToolbarPopover>
    </div>
  );
}
