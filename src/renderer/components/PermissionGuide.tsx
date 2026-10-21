// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from "react";
import { baseline } from "../ipc";
import baselineIcon from "../../../assets/app-icon.icon/Assets/Image 2.png";
import type { PermissionGuideInfo, PermissionGuideAction } from "../../shared/permissionGuide";

export function PermissionGuide() {
  const [info, setInfo] = useState<PermissionGuideInfo>({});
  const [message, setMessage] = useState("");
  const canDrag = Boolean(info.appPath && info.iconDataURL);
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
      <p>Let Baseline update and remove protected apps.</p>
      {
        <div className="permission-drag-example">
          <img
            src={info.iconDataURL ?? baselineIcon}
            alt="Baseline app — drag to the App Management list in Settings"
            draggable={canDrag}
            onDragStart={(event) => {
              event.preventDefault();
              if (canDrag) action("drag");
            }}
          />
          <span aria-hidden="true">→</span>
          <span>
            App Management
            <br />
            <small>{canDrag ? "Drag here in Settings" : "Enable in Settings"}</small>
          </span>
        </div>
      }
      <p>
        {canDrag
          ? "Drag the icon into Settings, or use + to select Baseline. Then turn it on."
          : "Turn on Baseline in App Management. If absent, use + to select it."}
      </p>
      <div className="permission-guide-actions">
        <button type="button" className="primary-button" onClick={() => action("settings")}>
          Open Settings
        </button>
        <button type="button" className="ghost-button" onClick={() => action("close")}>
          Later
        </button>
      </div>
      <p className="permission-guide-note">Privacy &amp; Security → App Management</p>
      {message && (
        <p role="status" className="permission-guide-note">
          {message}
        </p>
      )}
    </main>
  );
}
