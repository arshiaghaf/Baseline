// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { PermissionHelp } from "./PermissionHelp";
import { SelfUpdateButton } from "./SelfUpdateButton";
import { baseline } from "../ipc";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FolderPlus,
  Info,
  LockKeyhole,
  ShieldCogCorner,
  Terminal,
  X,
  XCircle
} from "lucide-react";
import type { AppMetadata } from "../../shared/appMetadata";
import type { AppearancePreference, BaselineSnapshot } from "../../shared/domain";
import type { SettingsSectionID, TogglePatch } from "../types";
import {
  settingsSidebarItems,
  toolbarIconStrokeWidth,
  sidebarIconStrokeWidth,
  primarySettingsSidebarItems,
  appearanceOptions
} from "../constants";
import { PanelTitle } from "./CommonControls";
import {
  homebrewReadyDetail,
  defaultScanDirectoryLabel,
  clampRefreshIntervalMinutes
} from "../helpers/labels";
import {
  buildProfileSummary,
  profileSourceShareLabel,
  profileSourceClass,
  profileSourceCountLabel,
  profileSourcePercentLabel
} from "../helpers/profile";

export function SettingsView({ snapshot }: { snapshot: BaselineSnapshot }) {
  const [selectedSection, setSelectedSection] = useState<SettingsSectionID>("general");
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [appMetadata, setAppMetadata] = useState<AppMetadata>();
  const contentRef = useRef<HTMLElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const selectedItem = settingsSidebarItems.find((item) => item.id === selectedSection);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const topbar = topbarRef.current;
    if (!content || !topbar) return;
    const alignTopbar = () => {
      const gutter = Math.max(0, content.offsetWidth - content.clientWidth);
      topbar.style.setProperty("--settings-scrollbar-width", `${gutter}px`);
    };
    alignTopbar();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(alignTopbar);
    observer?.observe(content);
    window.addEventListener("resize", alignTopbar);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", alignTopbar);
    };
  }, []);

  useEffect(() => {
    void baseline.getAppMetadata().then(setAppMetadata);
  }, []);

  return (
    <main className="app-shell settings-shell">
      <SettingsSidebar selectedSection={selectedSection} onSelectSection={setSelectedSection} />
      <section className="workspace">
        <header className="topbar settings-topbar" ref={topbarRef}>
          <div className="settings-topbar-inner">
            <div className="topbar-title">
              <h1>{selectedItem?.label ?? "Settings"}</h1>
            </div>
            {selectedSection === "profile" && <ProfileTopbarIndicators />}
          </div>
        </header>

        <section className="content settings-content" ref={contentRef}>
          <section className="stack">
            <SettingsPane
              appMetadata={appMetadata}
              diagnosticsCopied={diagnosticsCopied}
              onDiagnosticsCopiedChange={setDiagnosticsCopied}
              section={selectedSection}
              snapshot={snapshot}
            />
          </section>
        </section>
      </section>
    </main>
  );
}

export function ProfileTopbarIndicators() {
  return (
    <div className="topbar-actions profile-topbar-indicators" aria-label="Profile privacy details">
      <span
        className="toolbar-button refresh-button profile-topbar-indicator private"
        tabIndex={0}
        aria-label="Private profile. Your profile is only visible to you and stays private on this Mac."
      >
        <LockKeyhole size={13} strokeWidth={toolbarIconStrokeWidth} />
        <span className="profile-topbar-indicator-label">Private</span>
        <span className="profile-topbar-tooltip" role="tooltip">
          Your profile is only visible to you and stays private on this Mac.
        </span>
      </span>
      <span
        className="toolbar-button refresh-button profile-topbar-indicator icon-only"
        tabIndex={0}
        aria-label="Only updates and installs completed with Baseline are counted."
      >
        <Info size={15} strokeWidth={toolbarIconStrokeWidth} />
        <span className="profile-topbar-tooltip" role="tooltip">
          Only updates and installs completed with Baseline are counted.
        </span>
      </span>
    </div>
  );
}

export function SettingsSidebar({
  selectedSection,
  onSelectSection
}: {
  selectedSection: SettingsSectionID;
  onSelectSection: (section: SettingsSectionID) => void;
}) {
  return (
    <aside className="sidebar settings-sidebar">
      <div className="settings-sidebar-header">
        <button className="back-to-app-button" onClick={() => void baseline.showMainWindow()}>
          <ArrowLeft size={15} strokeWidth={sidebarIconStrokeWidth} />
          <span>Back to app</span>
        </button>
      </div>
      <nav className="source-list">
        {primarySettingsSidebarItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={selectedSection === item.id ? "selected" : ""}
              key={item.id}
              onClick={() => onSelectSection(item.id)}
            >
              <Icon size={16} strokeWidth={sidebarIconStrokeWidth} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <button
          className={selectedSection === "diagnostics" ? "selected" : ""}
          onClick={() => onSelectSection("diagnostics")}
        >
          <ShieldCogCorner size={16} strokeWidth={sidebarIconStrokeWidth} />
          <span>Diagnostics</span>
        </button>
      </div>
    </aside>
  );
}

export function SettingsPane({
  appMetadata,
  diagnosticsCopied,
  onDiagnosticsCopiedChange,
  section,
  snapshot
}: {
  appMetadata?: AppMetadata;
  diagnosticsCopied: boolean;
  onDiagnosticsCopiedChange: (copied: boolean) => void;
  section: SettingsSectionID;
  snapshot: BaselineSnapshot;
}) {
  const [cleanupRequestPending, setCleaningUp] = useState(false);
  const [refreshRequestPending, setRefreshRequestPending] = useState(false);
  const cleaningUp = cleanupRequestPending || snapshot.isCleaningUpHomebrew;
  const [cleanupResponseMessage, setCleanupMessage] = useState("");
  const cleanupMessage = snapshot.homebrewCleanupMessage ?? cleanupResponseMessage;
  const cleanupPending = useRef(false);
  const configurationValidated =
    snapshot.homebrewConfigurationBlocked && snapshot.homebrewConfigurationValidated;
  const cleanUp = async () => {
    if (cleanupPending.current) return;
    cleanupPending.current = true;
    setCleaningUp(true);
    setCleanupMessage("");
    try {
      setCleanupMessage(await baseline.cleanUpHomebrew());
    } catch {
      setCleanupMessage("Homebrew cleanup could not run. Please try again.");
    } finally {
      cleanupPending.current = false;
      setCleaningUp(false);
    }
  };
  switch (section) {
    case "general":
      return (
        <>
          <section className="panel settings-panel">
            <PanelTitle
              title="Update Tools"
              action={
                <button
                  className="ghost-button small-button"
                  disabled={snapshot.isHomebrewCommandLocked || cleaningUp}
                  onClick={() => void baseline.refreshToolStatus()}
                >
                  Refresh
                </button>
              }
            />
            <div className="settings-panel-box">
              <ToolStatus
                label="Homebrew"
                description="Find updates for installed casks and formulae."
                missingDetail="Homebrew is not detected on this Mac. Install Homebrew to enable this source."
                ready={snapshot.isHomebrewInstalled}
                blocked={snapshot.homebrewConfigurationBlocked}
                readyDetail={homebrewReadyDetail(snapshot)}
              />
              {snapshot.homebrewConfigurationBlocked && (
                <div
                  className="settings-row settings-row-action"
                  role="group"
                  aria-label="Homebrew configuration actions"
                >
                  <SettingsRowText label="Homebrew configuration" />
                  <div className="settings-row-actions">
                    <button
                      className="ghost-button small-button"
                      disabled={
                        refreshRequestPending ||
                        snapshot.isRefreshing ||
                        snapshot.isChecking ||
                        snapshot.isHomebrewCommandLocked ||
                        cleaningUp
                      }
                      onClick={() => {
                        setRefreshRequestPending(true);
                        void baseline.refresh(false).then(
                          () => setRefreshRequestPending(false),
                          () => setRefreshRequestPending(false)
                        );
                      }}
                    >
                      Check for updates
                    </button>
                    {!configurationValidated && (
                      <button
                        className="ghost-button small-button"
                        onClick={() => {
                          const url = new URL("https://github.com/arshiaghaf/Baseline/issues/new");
                          url.searchParams.set("template", "bug_report.yml");
                          url.searchParams.set(
                            "logs",
                            `Homebrew configuration blocked: ${snapshot.homebrewConfigurationReason?.kind ?? "unknown"}`
                          );
                          void baseline.openExternal(url.href);
                        }}
                      >
                        Report issue
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div
                className="settings-row settings-row-action homebrew-cleanup-row"
                role="group"
                aria-label="Homebrew cleanup"
              >
                <div>
                  <SettingsRowText
                    label="Homebrew cleanup"
                    description="Remove old package versions and cached downloads to free space. Homebrew may also remove supporting packages that are no longer needed. This applies to all Homebrew packages, including ignored items, and cannot be undone."
                  />
                  {cleanupMessage && (
                    <p className="settings-row-subtext" role="status">
                      {cleanupMessage}
                    </p>
                  )}
                </div>
                <button
                  className="danger-button small-button"
                  disabled={
                    !snapshot.isHomebrewInstalled ||
                    snapshot.homebrewConfigurationBlocked ||
                    snapshot.isHomebrewCleanupLocked ||
                    cleaningUp
                  }
                  onClick={() => void cleanUp()}
                  title="Runs brew cleanup using your Homebrew settings. Unused dependencies may be removed."
                >
                  {cleaningUp ? "Cleaning up…" : "Clean up Homebrew"}
                </button>
              </div>
              <ToolStatus
                label="mas"
                description="Use the App Store helper when it is available."
                missingDetail="The mas helper is not detected on this Mac. Without mas, Baseline opens App Store links instead of installing App Store updates directly."
                ready={snapshot.isMasInstalled}
                enabled={snapshot.useMasForAppStoreUpdates}
              />
              <Toggle
                label="Use mas for App Store updates"
                description="Use the optional mas command-line tool to try App Store updates. It may need App Store sign-in or administrator authorization. When disabled, or if an update fails, Baseline opens the App Store link instead."
                value={snapshot.useMasForAppStoreUpdates}
                patch="useMasForAppStoreUpdates"
                disabled={!snapshot.isMasInstalled}
              />
              <PermissionHelp />
            </div>
          </section>
          <section className="panel settings-panel">
            <PanelTitle title="Refresh" />
            <div className="settings-panel-box">
              <Toggle
                label="Auto refresh"
                description="Check for updates automatically in the background."
                value={snapshot.autoRefreshEnabled}
                patch="autoRefreshEnabled"
              />
              <RefreshIntervalInput
                value={snapshot.refreshIntervalMinutes}
                disabled={!snapshot.autoRefreshEnabled}
              />
            </div>
          </section>
          <section className="panel settings-panel">
            <PanelTitle
              title="Scan Directories"
              action={
                <button
                  className="toolbar-button"
                  onClick={() => void baseline.chooseDirectory()}
                  title="Add directory"
                >
                  <FolderPlus size={15} />
                </button>
              }
            />
            <div className="settings-panel-box">
              <div className="settings-row-list">
                {snapshot.additionalDirectories.length === 0 ? (
                  <div className="settings-row settings-empty-row">
                    <SettingsRowText
                      label="Default Applications folders"
                      description="Baseline scans the system and user Applications folders automatically."
                    />
                  </div>
                ) : (
                  snapshot.defaultScanDirectories.map((directory) => (
                    <div className="settings-row settings-row-action" key={`default:${directory}`}>
                      <SettingsRowText
                        label={defaultScanDirectoryLabel(directory)}
                        description={directory}
                      />
                    </div>
                  ))
                )}
                {snapshot.additionalDirectories.map((directory) => (
                  <div className="settings-row settings-row-action" key={directory}>
                    <SettingsRowText label="Custom folder" description={directory} />
                    <button
                      className="toolbar-button"
                      onClick={() => void baseline.removeDirectory(directory)}
                      title="Remove"
                    >
                      <XCircle size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      );
    case "profile":
      return <ProfileSection snapshot={snapshot} />;
    case "appearance":
      return (
        <>
          <section className="panel settings-panel">
            <PanelTitle title="Theme" />
            <div className="settings-panel-box">
              <div className="settings-row settings-row-action">
                <SettingsRowText
                  label="App theme"
                  description="Use light, dark, or match your system."
                />
                <AppearanceSelector value={snapshot.appearancePreference} />
              </div>
            </div>
          </section>
          <section className="panel settings-panel">
            <PanelTitle title="Dock & Menu Bar" />
            <div className="settings-panel-box">
              <Toggle
                label="Show Dock icon"
                description="Show Baseline in the Dock and Command-Tab app switcher. Turning this off keeps the menu bar icon on so you can reopen Baseline."
                value={snapshot.showDockIcon}
                patch="showDockIcon"
              />
              <Toggle
                label="Show menu bar icon"
                description="Click for the compact update popover. Right-click for Refresh, Open Baseline, Settings, Check for Updates (Baseline itself), or Quit. Turning this off shows the Dock icon."
                value={snapshot.showMenuBarIcon}
                patch="showMenuBarIcon"
              />
            </div>
          </section>
        </>
      );
    case "diagnostics":
      return (
        <>
          <section className="panel settings-panel">
            <PanelTitle title="About" />
            <div className="settings-panel-box">
              <div className="settings-row settings-row-action">
                <span>Current version</span>
                <strong className="settings-row-value">{appMetadata?.version ?? "Loading"}</strong>
              </div>
              <div className="settings-row settings-row-action">
                <span>Baseline updates</span>
                <SelfUpdateButton />
              </div>
            </div>
          </section>
          <section className="panel settings-panel">
            <PanelTitle title="Diagnostics" />
            <div className="settings-panel-box">
              <div className="settings-row settings-row-action">
                <SettingsRowText
                  label="Diagnostic report"
                  description="Copy a local report with counts, tool status, scan paths, and the latest non-sensitive refresh message."
                />
                <button
                  className="primary-button wide"
                  onClick={() => {
                    void baseline.copyDiagnostics().then(() => onDiagnosticsCopiedChange(true));
                  }}
                >
                  {diagnosticsCopied ? "Copied" : "Copy Report"}
                </button>
              </div>
            </div>
          </section>
        </>
      );
  }
}

export function ProfileSection({ snapshot }: { snapshot: BaselineSnapshot }) {
  const profile = useMemo(() => buildProfileSummary(snapshot), [snapshot]);
  const activeSourceMix = profile.sourceMix.filter((source) => source.count > 0);
  const sourceMixTotal = profile.sourceMix.reduce((total, source) => total + source.count, 0);
  const resetNotice = snapshot.profileStats.resetNotice;
  const shouldShowResetWarning =
    Boolean(resetNotice) && snapshot.profileStatsResetAcknowledgedID !== resetNotice?.id;
  return (
    <div className="profile-page">
      <div className="profile-stack">
        <section className="panel settings-panel profile-start-section">
          <div className="settings-panel-box profile-start-panel-box">
            <div className="profile-start-summary">
              <strong>
                <span className="profile-start-value">{profile.startedUsing.relativeLabel}</span>
                <span className="profile-start-unit">with Baseline</span>
              </strong>
              <span className="profile-start-date">{profile.startedUsing.dateLabel}</span>
            </div>
          </div>
        </section>
        <section className="panel settings-panel profile-stats-section">
          <PanelTitle
            title="Stats"
            action={
              profile.incompleteHistory ? (
                <span
                  className="toolbar-button profile-topbar-indicator icon-only profile-stats-info"
                  tabIndex={0}
                  aria-label="Recorded history may omit earlier activity. Totals and rankings may be incomplete."
                >
                  <Info size={14} strokeWidth={toolbarIconStrokeWidth} />
                  <span className="profile-topbar-tooltip" role="tooltip">
                    Recorded history may omit earlier activity. Totals and rankings may be
                    incomplete.
                  </span>
                </span>
              ) : undefined
            }
          />
          <div className="settings-panel-box profile-panel-box">
            {snapshot.profileStats.integrityStatus === "unavailable" && (
              <p className="profile-empty-state">
                Stats verification is unavailable. New activity cannot be recorded until
                verification recovers.
              </p>
            )}
            <div className="profile-stat-grid">
              <ProfileMetric label="Total updates" value={String(profile.totalUpdates)} />
              <ProfileMetric label="Unique apps" value={String(profile.differentApps)} />
              <ProfileMetric label="Homebrew Installs" value={String(profile.discoverInstalls)} />
              <ProfileMetric label="Favorite source" value={profile.favoriteChannelLabel} />
            </div>
          </div>
        </section>
        <section className="panel settings-panel profile-source-section">
          <div className="settings-panel-box profile-source-panel-box">
            {activeSourceMix.length > 0 ? (
              <div className="profile-source-list">
                <div
                  className="profile-source-bar"
                  aria-label={activeSourceMix
                    .map((source) => profileSourceShareLabel(source, sourceMixTotal))
                    .join(", ")}
                  role="img"
                >
                  {activeSourceMix.map((source) => (
                    <span
                      className={`profile-source-segment ${profileSourceClass(source.channel)}`}
                      key={source.channel}
                      style={{ flexGrow: source.count }}
                    >
                      <span className="profile-source-tooltip" aria-hidden="true">
                        {profileSourceCountLabel(source)}
                      </span>
                    </span>
                  ))}
                </div>
                <div className="profile-source-legend">
                  {activeSourceMix.map((source) => (
                    <div
                      className="profile-source-chip"
                      key={source.channel}
                      aria-label={profileSourceShareLabel(source, sourceMixTotal)}
                    >
                      <span
                        className={`profile-source-dot ${profileSourceClass(source.channel)}`}
                        aria-hidden="true"
                      />
                      <span>{source.label}</span>
                      <strong>{profileSourcePercentLabel(source, sourceMixTotal)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="profile-empty-state">
                Update something with Baseline to build a source history.
              </p>
            )}
          </div>
        </section>
        <section className="panel settings-panel">
          <PanelTitle title="Most updated apps" />
          <div className="settings-panel-box profile-top-apps-panel-box">
            {profile.topApps.length > 0 ? (
              <ol className="profile-top-app-list">
                {profile.topApps.map((app) => (
                  <li key={app.targetID}>
                    <span className={`profile-top-app-rank profile-top-app-rank-${app.rank}`}>
                      {app.rank}
                    </span>
                    <span
                      className={
                        app.iconDataURL ? "profile-top-app-icon has-image" : "profile-top-app-icon"
                      }
                      aria-hidden="true"
                    >
                      {app.iconDataURL ? (
                        <img src={app.iconDataURL} alt="" draggable={false} />
                      ) : (
                        app.displayName.slice(0, 1).toUpperCase()
                      )}
                    </span>
                    <span className="profile-top-app-name">{app.displayName}</span>
                    <strong>
                      {app.count} update{app.count === 1 ? "" : "s"}
                    </strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="profile-empty-state">Apps you update with Baseline will appear here.</p>
            )}
          </div>
        </section>
        <section className="panel settings-panel">
          <PanelTitle title="Most updated tools" />
          <div className="settings-panel-box profile-top-apps-panel-box">
            {profile.topHomebrewItems.length > 0 ? (
              <ol className="profile-top-app-list profile-top-tool-list">
                {profile.topHomebrewItems.map((item) => (
                  <li key={item.targetID}>
                    <span className={`profile-top-app-rank profile-top-app-rank-${item.rank}`}>
                      {item.rank}
                    </span>
                    <span className="profile-top-app-icon profile-top-tool-icon" aria-hidden="true">
                      <Terminal size={29} strokeWidth={2.2} />
                    </span>
                    <span className="profile-top-app-name">{item.displayName}</span>
                    <strong>
                      {item.count} update{item.count === 1 ? "" : "s"} · {item.kindLabel}
                    </strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="profile-empty-state">
                Tools you update with Baseline will appear here.
              </p>
            )}
          </div>
        </section>
      </div>
      {shouldShowResetWarning && (
        <section className="panel settings-panel profile-footer-panel">
          <div className="settings-panel-box">
            <div className="settings-row settings-row-action profile-warning-row">
              <SettingsRowText
                label="Stats were reset"
                description="Baseline could not verify the local stats history, so it started a fresh one on this Mac."
              />
              <button
                className="toolbar-button"
                onClick={() => void baseline.acknowledgeProfileStatsReset()}
                title="Dismiss"
                aria-label="Dismiss stats reset warning"
              >
                <X size={15} />
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export function ProfileMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="profile-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function AppearanceSelector({ value }: { value: AppearancePreference }) {
  return (
    <div className="appearance-options" role="group" aria-label="Appearance">
      {appearanceOptions.map((option) => {
        const Icon = option.icon;
        const selected = option.value === value;
        return (
          <button
            aria-pressed={selected}
            className={selected ? "selected" : ""}
            key={option.value}
            onClick={() => void baseline.updatePreferences({ appearancePreference: option.value })}
            type="button"
          >
            <Icon size={15} strokeWidth={toolbarIconStrokeWidth} />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function RefreshIntervalInput({ value, disabled }: { value: number; disabled: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const lastCommittedDraftRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const nextDraft = String(value);
    setDraft(nextDraft);
    if (lastCommittedDraftRef.current !== nextDraft) {
      lastCommittedDraftRef.current = undefined;
    }
  }, [value]);

  const commitDraft = () => {
    if (!draft) {
      setDraft(String(value));
      return;
    }
    const refreshIntervalMinutes = clampRefreshIntervalMinutes(Number.parseInt(draft, 10));
    const normalizedDraft = String(refreshIntervalMinutes);
    setDraft(normalizedDraft);
    if (lastCommittedDraftRef.current === normalizedDraft) {
      return;
    }
    lastCommittedDraftRef.current = normalizedDraft;
    void baseline.updatePreferences({ refreshIntervalMinutes });
  };

  return (
    <label
      className={
        disabled
          ? "settings-row settings-row-control settings-row-disabled"
          : "settings-row settings-row-control"
      }
    >
      <SettingsRowText
        label="Interval minutes"
        description="How often Baseline checks when auto refresh is on."
      />
      <input
        aria-label="Interval minutes"
        className="settings-number-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        disabled={disabled}
        value={draft}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          if (!/^\d*$/u.test(nextValue)) {
            return;
          }
          lastCommittedDraftRef.current = undefined;
          setDraft(nextValue);
        }}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitDraft();
          }
        }}
      />
    </label>
  );
}

export function Toggle({
  label,
  description,
  value,
  patch,
  disabled = false
}: {
  label: string;
  description: string;
  value: boolean;
  patch: TogglePatch;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        disabled
          ? "settings-row settings-row-control settings-row-disabled"
          : "settings-row settings-row-control"
      }
    >
      <SettingsRowText label={label} description={description} />
      <input
        aria-label={label}
        className="settings-switch"
        type="checkbox"
        role="switch"
        checked={value}
        disabled={disabled}
        onChange={(event) => {
          if (disabled) {
            return;
          }
          void baseline.updatePreferences({ [patch]: event.currentTarget.checked });
        }}
      />
    </label>
  );
}

export function SettingsRowText({
  label,
  description,
  secondaryDescription
}: {
  label: string;
  description?: string;
  secondaryDescription?: string;
}) {
  return (
    <span className="settings-row-text">
      <span>{label}</span>
      {description && <span className="settings-row-subtext">{description}</span>}
      {secondaryDescription && <span className="settings-row-subtext">{secondaryDescription}</span>}
    </span>
  );
}

export function ToolStatus({
  label,
  description,
  missingDetail,
  ready,
  readyDetail,
  blocked = false,
  enabled = true
}: {
  label: string;
  description: string;
  missingDetail: string;
  ready: boolean;
  readyDetail?: string;
  blocked?: boolean;
  enabled?: boolean;
}) {
  const active = ready && enabled && !blocked;
  const statusLabel = blocked
    ? "Needs attention"
    : ready
      ? enabled
        ? "Enabled"
        : "Not used"
      : "Not detected";
  const detail = ready ? (readyDetail ?? description) : `${description} ${missingDetail}`;
  return (
    <div className="settings-row settings-row-status">
      <SettingsRowText label={label} description={detail} />
      <span className={active ? "settings-status-label enabled" : "settings-status-label muted"}>
        <span className="settings-status-glyph" aria-hidden="true" />
        <span>{statusLabel}</span>
      </span>
    </div>
  );
}
