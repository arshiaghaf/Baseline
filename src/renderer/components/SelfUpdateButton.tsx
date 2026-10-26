// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { useState } from "react";
import { Download } from "lucide-react";
import { baseline } from "../ipc";

export function SelfUpdateButton({ toolbar = false }: { toolbar?: boolean }) {
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = checking
    ? "Checking for Baseline updates"
    : failed
      ? "Try checking for Baseline updates again"
      : toolbar
        ? "New Baseline Update Available"
        : "Check for Baseline updates";
  return (
    <button
      className={toolbar ? "toolbar-button self-update-toolbar-button" : "primary-button wide"}
      disabled={checking}
      title={label}
      aria-label={label}
      onClick={() => {
        setChecking(true);
        setFailed(false);
        void baseline
          .checkForBaselineUpdates()
          .catch(() => setFailed(true))
          .finally(() => setChecking(false));
      }}
    >
      {toolbar ? (
        <Download size={16} strokeWidth={2} />
      ) : checking ? (
        "Checking…"
      ) : (
        "Check for updates"
      )}
    </button>
  );
}
