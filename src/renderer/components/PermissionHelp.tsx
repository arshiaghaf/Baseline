// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { useState } from "react";
import { baseline } from "../ipc";

export function UpdateIntroduction() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <section className="panel update-introduction" aria-labelledby="update-introduction-title">
      <h2 id="update-introduction-title">Welcome to Baseline</h2>
      <p>
        Check installed apps and public update sources without granting broad access to your Mac.
        Updates may use Homebrew, open the App Store or a website, or open the installed app.
      </p>
      <p>
        Installing, updating, or removing protected apps may need <strong>App Management</strong>.
        If macOS says Baseline was prevented from modifying apps, enable Baseline in System Settings
        → Privacy &amp; Security → App Management, then retry. Some installations separately need
        your Mac administrator password. You can continue checking updates without granting this
        access.
      </p>
      <PermissionHelp />
      <button
        type="button"
        className="ghost-button small-button"
        onClick={() => {
          setDismissed(true);
          // Dismiss for this window even if saving fails; never block update checks.
          void baseline.updatePreferences({ updateIntroductionDismissed: true }).catch(() => {});
        }}
      >
        Got it
      </button>
    </section>
  );
}

export function PermissionHelp({ recovery = false }: { recovery?: boolean }) {
  return (
    <details className="permission-help">
      <summary>{recovery ? "Help with permissions" : "macOS permissions and updates"}</summary>
      {recovery && (
        <p>
          A permission error can mean a protected app, an unwritable folder, or another system
          restriction. It does not confirm that App Management access was denied.
        </p>
      )}
      <p>
        <strong>App Management:</strong> macOS may ask for approval when an update tool changes or
        removes another app. If macOS reports this, follow its notification or go to System Settings
        → Privacy &amp; Security → App Management. Review the app identified by macOS, then retry
        the action. Baseline cannot verify this setting; opening Settings does not grant access.
      </p>
      <p>
        <strong>Administrator authorization:</strong> some Homebrew installations and App Store
        update tools separately need your Mac administrator password. This is different from App
        Management. You can cancel and use the app’s own update route instead.
      </p>
      <p>
        Checking updates does not require Accessibility, Automation, or Full Disk Access. Additional
        scan folders may need access to the folder you select. You can keep checking other apps if
        access to one folder is denied. Find this help again in Settings → General → Update Tools.
      </p>
    </details>
  );
}
