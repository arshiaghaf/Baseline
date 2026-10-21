// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from "react";
import { baseline } from "../ipc";
import type { PermissionGuideInfo, PermissionGuideAction } from "../../shared/permissionGuide";

export function PermissionGuide() {
  const [info, setInfo] = useState<PermissionGuideInfo>({});
  const [message, setMessage] = useState("");
  const action = (value: PermissionGuideAction) => {
    void baseline.permissionGuide(value).then(
      (result) => {
        if (value === "info") setInfo(result);
        if (result.message) setMessage(result.message);
      },
      () => setMessage("Could not complete this step. Use the manual instructions below.")
    );
  };
  useEffect(() => {
    let disposed = false;
    void baseline.permissionGuide("info").then(
      (result) => {
        if (!disposed) {
          setInfo(result);
          setMessage(result.message ?? "");
        }
      },
      () => {
        if (!disposed) setMessage("Use the manual instructions below.");
      }
    );
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") void baseline.permissionGuide("close");
    };
    window.addEventListener("keydown", key);
    return () => {
      disposed = true;
      window.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <main className="permission-guide" aria-labelledby="permission-guide-title">
      <h1 id="permission-guide-title">Allow app changes</h1>
      <p>Move this guide by its title bar if it covers Settings.</p>
      <button type="button" className="primary-button" onClick={() => action("settings")}>
        Open App Management
      </button>
      <p>
        In System Settings → Privacy &amp; Security → App Management, turn on Baseline if it is
        listed.
      </p>
      {info.iconDataURL && (
        <div className="permission-drag-example">
          <img
            src={info.iconDataURL}
            alt="Baseline app — drag to the App Management list in Settings"
            draggable
            onDragStart={(event) => {
              event.preventDefault();
              action("drag");
            }}
          />
          <span aria-hidden="true">→</span>
          <span>
            App Management list
            <br />
            <small>Example destination</small>
          </span>
        </div>
      )}
      <p>
        If Baseline is absent and Settings accepts app drops, drag the icon into its list. Otherwise
        use the + button, if available, to select your installed Baseline.app. Then enable its
        switch.
      </p>
      <div className="permission-guide-actions">
        <button
          type="button"
          className="ghost-button"
          disabled={!info.appPath}
          onClick={() => action("finder")}
        >
          Show in Finder
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={!info.appPath}
          onClick={() => action("copy")}
        >
          Copy app path
        </button>
      </div>
      <p role="status">{message}</p>
      <p>
        Baseline cannot verify this permission. Opening Settings or dragging the app does not
        confirm access. Close this guide, then retry your original action in Baseline.
      </p>
      <button type="button" className="primary-button" onClick={() => action("close")}>
        Done — return to Baseline to retry
      </button>
    </main>
  );
}
