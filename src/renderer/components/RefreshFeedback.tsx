// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import React from "react";
import { AlertTriangle } from "lucide-react";
import type { BaselineSnapshot } from "../../shared/domain";
import { baseline } from "../ipc";

export function RefreshFeedback({ snapshot }: { snapshot: BaselineSnapshot }) {
  const checks = Object.values(snapshot.appProviderChecks ?? {});
  const pending = checks.filter((check) => check.status === "pending").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const unresolved = checks.filter((check) => check.status === "unresolved").length;
  const dates = checks
    .flatMap((check) => (check.discoveryCheckedAt ? [check.discoveryCheckedAt] : []))
    .sort();
  const oldestSearch = dates[0];

  return (
    <>
      {snapshot.refreshErrorMessage && (
        <div className="notice danger" role="status">
          <AlertTriangle size={15} />
          <span>{snapshot.refreshErrorMessage}</span>
        </div>
      )}
      {snapshot.lastRefreshNoticeMessage && !snapshot.refreshErrorMessage && (
        <div className="notice" role="status">
          <AlertTriangle size={15} />
          <span>{snapshot.lastRefreshNoticeMessage}</span>
        </div>
      )}
      {(pending > 0 || failed > 0 || unresolved > 0) && (
        <div className="notice app-check-notice" role="status">
          <div>
            {pending > 0 && (
              <p>
                Checking updates for {pending} {pending === 1 ? "app" : "apps"}. Results are
                incomplete.
              </p>
            )}
            {failed > 0 && (
              <p>
                Could not check updates for {failed} {failed === 1 ? "app" : "apps"}. Previous
                results may still appear.
              </p>
            )}
            {unresolved > 0 && (
              <p>
                No verified update source for {unresolved} {unresolved === 1 ? "app" : "apps"}.
                These apps may still have updates.
              </p>
            )}
          </div>
        </div>
      )}
      {checks.length > 0 && (
        <div className="app-source-actions">
          <button
            className="ghost-button"
            title="Search all app update sources now, including other sources for apps with a verified source."
            disabled={snapshot.isRefreshing || snapshot.isHomebrewCleanupLocked}
            onClick={() => void baseline.refresh(false, true)}
          >
            Search sources again
          </button>
          <details>
            <summary>About source checks</summary>
            <p>
              Refresh checks known sources for new versions and searches apps with no verified
              source. Other sources for known apps are searched every six hours, when an app
              changes, or with Search sources again.
            </p>
            {oldestSearch && (
              <p>Oldest source search: {new Date(oldestSearch).toLocaleString()}.</p>
            )}
          </details>
        </div>
      )}
    </>
  );
}
