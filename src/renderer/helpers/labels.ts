// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { externalAppUpdateAction } from "../../shared/appUpdateAction";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewManagedItem,
  MenuTab,
  RecentlyUpdatedRecord,
  UpdateRecord
} from "../../shared/domain";
import { homebrewPresentationLabel, sourceDisplayName } from "../../shared/domain";
import { homebrewConfigurationValidatedMessage } from "../../shared/homebrewConfiguration";
import { compareVersions } from "../../shared/version";
import { compactVersionLabelMaxLength } from "../constants";
import { uninstallableHomebrewItemForApp } from "./sections";

export function defaultScanDirectoryLabel(directory: string): string {
  if (directory === "/Applications") {
    return "System Applications";
  }
  return "User Applications";
}

export function clampRefreshIntervalMinutes(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 5), 1440);
}

export function sectionTitleLabel(title: string): string {
  const match = /^(?<label>.+?)\s+\((?<count>\d+)\)$/u.exec(title);
  return match?.groups?.label ?? title;
}

export function hasLongVersionLabel(...labels: string[]): boolean {
  return labels.some((label) => label.length > compactVersionLabelMaxLength);
}

export function appUpdateVersionChange(update: UpdateRecord): { from: string; to: string } {
  if (shouldShowAppBuildVersion(update)) {
    return {
      from: versionLabelWithBuild(update.localVersion.raw, update.localBuildVersion?.raw),
      to: versionLabelWithBuild(update.remoteVersion.raw, update.remoteBuildVersion?.raw)
    };
  }
  return {
    from: update.localVersion.raw || "unknown",
    to: update.remoteVersion.raw || "unknown"
  };
}

export function shouldShowAppBuildVersion(update: UpdateRecord): boolean {
  return Boolean(
    update.localBuildVersion?.raw.trim() &&
    update.remoteBuildVersion?.raw.trim() &&
    compareVersions(update.localVersion, update.remoteVersion) === 0 &&
    compareVersions(update.localBuildVersion, update.remoteBuildVersion) !== 0
  );
}

export function versionLabelWithBuild(versionRaw: string, buildRaw?: string): string {
  const displayVersion = versionRaw.trim() || "unknown";
  const buildVersion = buildRaw?.trim();
  return buildVersion ? `${displayVersion} (${buildVersion})` : displayVersion;
}

export function homebrewReadyDetail(snapshot: BaselineSnapshot): string {
  if (snapshot.homebrewConfigurationBlocked) {
    if (snapshot.homebrewConfigurationValidated) return homebrewConfigurationValidatedMessage;
    return homebrewConfigurationDetail(snapshot.homebrewConfigurationReason);
  }
  const caskCount = snapshot.homebrewItems.filter((item) => item.kind === "cask").length;
  const formulaCount = snapshot.homebrewItems.filter((item) => item.kind === "formula").length;
  const appLinkedCaskCount = snapshot.homebrewItems.filter(
    (item) => item.kind === "cask" && item.appID
  ).length;

  if (caskCount === 0) {
    return `Homebrew detected with 0 installed casks and ${countLabel(
      formulaCount,
      "formula",
      "formulae"
    )}; app updates will not use Homebrew unless a matching cask is installed.`;
  }

  return `Homebrew detected with ${countLabel(
    caskCount,
    "installed cask"
  )}, ${countLabel(appLinkedCaskCount, "app-linked cask")}, and ${countLabel(
    formulaCount,
    "formula",
    "formulae"
  )}.`;
}

export function homebrewConfigurationDetail(
  reason: BaselineSnapshot["homebrewConfigurationReason"]
): string {
  const file = reason?.file;
  switch (reason?.kind) {
    case "sudo-askpass":
      return `${file ?? "A Homebrew configuration file"} sets SUDO_ASKPASS, which conflicts with Baseline’s password prompt. Remove that assignment.`;
    case "reserved-askpass":
      return `${file ?? "A Homebrew configuration file"} sets a reserved HOMEBREW_BASELINE_ASKPASS_* setting. Remove that assignment so Baseline can manage its password prompt.`;
    case "unsupported-content":
      return `${file ?? "A Homebrew configuration file"} has unsupported characters or line endings in a Homebrew setting. Edit that setting or comment out its line.`;
    case "invalid-assignment":
      if (file && reason.line && Number.isSafeInteger(reason.line) && reason.line > 0)
        return `${file}, line ${reason.line}, has an invalid assignment. Use NAME=value syntax or comment out that line.`;
      return `${file ?? "A Homebrew configuration line"} has an invalid assignment. Use NAME=value syntax or comment out that line.`;
    case "unreadable":
      return `Baseline couldn’t read ${file ?? "a Homebrew configuration file"}. Check that your account can access the file and its parent folders.`;
    case "non-regular":
      return `${file ?? "A brew.env path"} doesn’t point to a regular file. Use a regular brew.env text file at this location.`;
    case "oversize":
      return `${file ?? "A Homebrew configuration file"} exceeds 64 KiB. Reduce its size to 64 KiB or less.`;
    case "invalid-setting-path":
      if (reason.setting) {
        return file
          ? `${file} sets an invalid ${reason.setting} path. Use an absolute path without . or .. components.`
          : `The ${reason.setting} environment setting has an invalid path. Use an absolute path without . or .. components.`;
      }
      break;
    case "invalid-folder":
      return `Baseline couldn’t access ${file ?? "a Homebrew configuration file"} because its folder path is invalid. Repair the missing link or invalid folder.`;
    case "invalid-executable":
      return reason.path
        ? `Baseline couldn’t validate Homebrew at ${reason.path}. Check that it points to an accessible Homebrew executable at an absolute path ending in /bin/brew.`
        : "Baseline couldn’t validate the Homebrew executable. Check that it is accessible at an absolute path ending in /bin/brew.";
    case "changed":
      return file
        ? `${file} changed while Baseline checked it. Finish any configuration changes.`
        : "Homebrew configuration changed while Baseline checked it. Finish any configuration changes.";
    case "incomplete-read":
      return `Baseline couldn’t finish reading ${file ?? "a Homebrew configuration file"}. Check that the file is accessible and no longer being changed.`;
  }
  return file
    ? `Baseline couldn’t validate the Homebrew configuration at ${file}. Check that it’s accessible and finish any configuration changes.`
    : "Baseline couldn’t validate the Homebrew configuration. Check that it’s accessible and finish any configuration changes.";
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function sourceLabel(update: UpdateRecord): string {
  if (update.source === "unknown") return "Update";
  return sourceDisplayName(update.source);
}

export function appUpdateReadyLabel(
  app: AppRecord,
  snapshot: BaselineSnapshot,
  update: UpdateRecord
): string {
  if (update.source === "homebrew" && !uninstallableHomebrewItemForApp(app, snapshot)) {
    return "Open app";
  }
  if (update.source === "sparkle" || update.source === "web") {
    const action = externalAppUpdateAction(update);
    return action.kind === "download"
      ? "Download"
      : action.kind === "website"
        ? "Visit website"
        : "Open app";
  }
  return "Update";
}

export function appSourceLabel(
  app: AppRecord,
  snapshot: BaselineSnapshot,
  recentRecord?: RecentlyUpdatedRecord
): string | undefined {
  if (app.macOSManagedPath) return "Managed by macOS";
  const update = snapshot.updates.find((candidate) => candidate.appID === app.id);
  if (update) {
    if (
      update.source === "homebrew" &&
      app.sourceHint === "sparkle" &&
      !uninstallableHomebrewItemForApp(app, snapshot)
    ) {
      return sourceDisplayName(app.sourceHint);
    }
    return sourceLabel(update);
  }

  if (recentRecord?.source && recentRecord.source !== "unknown") {
    if (recentRecord.source === "homebrew") {
      const uninstallableItem = uninstallableHomebrewItemForApp(app, snapshot);
      if (uninstallableItem?.presentation && uninstallableItem.presentation !== "app") {
        return homebrewItemLabel(uninstallableItem);
      }
    }
    return sourceDisplayName(recentRecord.source);
  }

  const uninstallableItem = uninstallableHomebrewItemForApp(app, snapshot);
  if (uninstallableItem) {
    return uninstallableItem.presentation === "app" || uninstallableItem.appID === app.id
      ? "Homebrew"
      : homebrewItemLabel(uninstallableItem);
  }

  return app.sourceHint === "unknown" ? undefined : sourceDisplayName(app.sourceHint);
}

export function homebrewItemLabel(item: HomebrewManagedItem, appCaskLabel?: string): string {
  if (item.presentation === "app" && appCaskLabel) {
    return appCaskLabel;
  }
  return homebrewPresentationLabel(item.kind, item.presentation);
}

export function selectedTabTitle(tab: MenuTab): string {
  if (tab === "all") return "All";
  if (tab === "apps") return "Apps";
  if (tab === "installed") return "Installed";
  if (tab === "ignored") return "Ignored";
  return "Homebrew";
}

export function updatedRelativeLabel(updatedAt: string, now = Date.now()): string {
  const updatedTime = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedTime)) {
    return "Updated recently";
  }

  const days = Math.max(0, Math.floor((now - updatedTime) / 86_400_000));
  if (days === 0) {
    return "Updated today";
  }
  return `Updated ${days} ${days === 1 ? "day" : "days"} ago`;
}
