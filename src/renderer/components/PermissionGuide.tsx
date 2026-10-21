// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from "react";
import { ArrowUpRight, GripVertical, X } from "lucide-react";
import { baseline } from "../ipc";
import baselineIcon from "../../../assets/app-icon.icon/Assets/Image 2.png";
import type { PermissionGuideInfo, PermissionGuideAction } from "../../shared/permissionGuide";

export function PermissionGuide() {
  const [info, setInfo] = useState<PermissionGuideInfo>({});
  const [message, setMessage] = useState("");
  const [settingsOpened, setSettingsOpened] = useState(false);
  const canDrag = Boolean(info.appPath && info.iconDataURL);
  const action = (value: PermissionGuideAction) => {
    void baseline.permissionGuide(value).then(
      (result) => {
        if (value === "info") setInfo(result);
        if (value === "settings") setSettingsOpened(true);
        if (result.message)
          setMessage(result.message.startsWith("Settings requested") ? "" : result.message);
      },
      () => setMessage("Open System Settings → Privacy & Security → App Management.")
    );
  };
  useEffect(() => {
    let disposed = false;
    void baseline.permissionGuide("info").then(
      (result) => {
        if (!disposed) {
          setInfo(result);
        }
      },
      () => {
        if (!disposed) setMessage("Open System Settings → Privacy & Security → App Management.");
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
  const instruction =
    message ||
    (!settingsOpened
      ? "Allow Baseline to update protected apps."
      : canDrag
        ? "Drag Baseline into App Management, or use +. Then turn it on."
        : "Turn on Baseline in App Management. Use + to add it if needed.");
  return (
    <main className="app-shell permission-guide" aria-labelledby="permission-guide-title">
      <header className="permission-guide-header">
        <h1 id="permission-guide-title">App Management</h1>
        <button
          type="button"
          className="permission-guide-close"
          aria-label="Later"
          onClick={() => action("close")}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <p className="permission-guide-instruction" role="status">
        {instruction}
      </p>
      <div
        className={`permission-app-card${canDrag ? " can-drag" : ""}`}
        draggable={canDrag}
        onDragStart={(event) => {
          event.preventDefault();
          if (canDrag) action("drag");
        }}
      >
        <span className="permission-app-icon">
          <img src={info.iconDataURL ?? baselineIcon} alt="Baseline app" draggable={false} />
        </span>
        <span className="permission-app-name">
          Baseline<span>{canDrag ? "Drag to Settings" : "App update access"}</span>
        </span>
        {canDrag ? (
          <GripVertical size={17} aria-label="Drag app" />
        ) : (
          <ArrowUpRight size={16} aria-hidden="true" />
        )}
      </div>
      <button
        type="button"
        className="primary-button permission-settings-button"
        title="System Settings → Privacy & Security → App Management"
        aria-description="If a different pane opens, choose Privacy & Security, then App Management."
        onClick={() => action("settings")}
      >
        {settingsOpened ? "Open Settings again" : "Open Settings"}
        <ArrowUpRight size={12} aria-hidden="true" />
      </button>
    </main>
  );
}
