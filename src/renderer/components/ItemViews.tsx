// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { baseline } from "../ipc";
import React from "react";
import { Link2, Package, Terminal } from "lucide-react";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewCaskDiscoveryItem,
  HomebrewManagedItem
} from "../../shared/domain";
import { homebrewPresentationLabel } from "../../shared/domain";
import { isCask } from "../../shared/homebrewAppLinking";
import { ActionConfirmationContext } from "./ActionConfirmation";
import {
  appControlState,
  appIsWaitingForAdmin,
  isHomebrewCommandActive,
  actionStateFromFlags,
  homebrewControlState,
  isWaitingForAdmin
} from "../helpers/actionState";
import {
  appSourceLabel,
  appUpdateReadyLabel,
  appUpdateVersionChange,
  updatedRelativeLabel,
  homebrewItemLabel
} from "../helpers/labels";
import { UpdateActionButton, RowMoreActionButton, VersionChange } from "./CommonControls";
import { matchingAppForHomebrewItem } from "../helpers/sections";
import { appCheckLabel } from "../helpers/appChecks";

export function AppIconButton({ app }: { app: AppRecord }) {
  return (
    <button
      className={
        app.iconDataURL
          ? "app-icon app-icon-image clickable-app-icon"
          : "app-icon clickable-app-icon"
      }
      onClick={() => void baseline.openApp(app.id)}
      title="Open app"
      aria-label="Open app"
    >
      {app.iconDataURL ? (
        <img src={app.iconDataURL} alt="" draggable={false} />
      ) : (
        app.displayName.slice(0, 1).toUpperCase()
      )}
    </button>
  );
}

export function AppUpdateCard({ app, snapshot }: { app: AppRecord; snapshot: BaselineSnapshot }) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked,
    isHomebrewUpdatePinned
  } = appControlState(app, snapshot);
  const label = appSourceLabel(app, snapshot);

  return (
    <article className={isIgnored ? "item-card update-card ignored-row" : "item-card update-card"}>
      <div className="item-card-top">
        <AppIconButton app={app} />
        <div className="item-card-actions">
          {update && !isHomebrewUpdatePinned && (
            <UpdateActionButton
              state={actionState}
              disabled={isUninstalling}
              readyLabel={appUpdateReadyLabel(app, snapshot, update)}
              onAction={() => void baseline.performAppUpdate(app.id)}
            />
          )}
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            onToggleIgnore={() => void baseline.toggleIgnoredApp(app.id)}
            uninstallLabel="Uninstall"
            canUninstall={Boolean(uninstallableItem)}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() =>
              uninstallableItem &&
              requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
            }
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {label && <span>{label}</span>}
          {isHomebrewUpdatePinned && (
            <span title="Pinned in Homebrew; unpin in Homebrew to update.">Pinned in Homebrew</span>
          )}
        </div>
        <p>
          {update ? (
            <VersionChange
              from={appUpdateVersionChange(update).from}
              to={appUpdateVersionChange(update).to}
              collapseLong
            />
          ) : (
            app.localVersion.raw || "unknown"
          )}
        </p>
        <AppProviderStatus snapshot={snapshot} app={app} />
        <AdminPasswordStatus snapshot={snapshot} app={app} />
      </div>
    </article>
  );
}

export function RecentAppCard({ app, snapshot }: { app: AppRecord; snapshot: BaselineSnapshot }) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked,
    isHomebrewUpdatePinned
  } = appControlState(app, snapshot);
  const recentlyUpdatedRecord = snapshot.recentlyUpdated.find((record) => record.appID === app.id);
  const label = appSourceLabel(app, snapshot, recentlyUpdatedRecord);

  return (
    <article className={isIgnored ? "item-card recent-card ignored-row" : "item-card recent-card"}>
      <div className="item-card-top">
        <AppIconButton app={app} />
        <div className="item-card-actions">
          {update && !isHomebrewUpdatePinned && (
            <UpdateActionButton
              state={actionState}
              disabled={isUninstalling}
              readyLabel={appUpdateReadyLabel(app, snapshot, update)}
              onAction={() => void baseline.performAppUpdate(app.id)}
            />
          )}
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            onToggleIgnore={() => void baseline.toggleIgnoredApp(app.id)}
            uninstallLabel="Uninstall"
            canUninstall={Boolean(uninstallableItem)}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() =>
              uninstallableItem &&
              requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
            }
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {label && <span>{label}</span>}
          {isHomebrewUpdatePinned && (
            <span title="Pinned in Homebrew; unpin in Homebrew to update.">Pinned in Homebrew</span>
          )}
        </div>
        <p>
          {recentlyUpdatedRecord
            ? updatedRelativeLabel(recentlyUpdatedRecord.updatedAt)
            : "Updated recently"}
        </p>
        <AppProviderStatus snapshot={snapshot} app={app} />
        <AdminPasswordStatus snapshot={snapshot} app={app} />
      </div>
    </article>
  );
}

export function IgnoredAppCard({ app, snapshot }: { app: AppRecord; snapshot: BaselineSnapshot }) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked,
    isHomebrewUpdatePinned
  } = appControlState(app, snapshot);
  const label = appSourceLabel(app, snapshot);

  return (
    <article className="item-card ignored-card ignored-row">
      <div className="item-card-top">
        <AppIconButton app={app} />
        <div className="item-card-actions">
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            updateAction={
              update && !isHomebrewUpdatePinned
                ? {
                    state: actionState,
                    disabled: isUninstalling,
                    readyLabel: appUpdateReadyLabel(app, snapshot, update),
                    onAction: () => void baseline.performAppUpdate(app.id)
                  }
                : undefined
            }
            onToggleIgnore={() => void baseline.toggleIgnoredApp(app.id)}
            uninstallLabel="Uninstall"
            canUninstall={Boolean(uninstallableItem)}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() =>
              uninstallableItem &&
              requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
            }
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {label && <span>{label}</span>}
          {isHomebrewUpdatePinned && (
            <span title="Pinned in Homebrew; unpin in Homebrew to update.">Pinned in Homebrew</span>
          )}
        </div>
        <p>
          {update ? (
            <VersionChange
              from={appUpdateVersionChange(update).from}
              to={appUpdateVersionChange(update).to}
              collapseLong
            />
          ) : (
            app.localVersion.raw || "unknown"
          )}
        </p>
        <AppProviderStatus snapshot={snapshot} app={app} />
        <AdminPasswordStatus snapshot={snapshot} app={app} />
      </div>
    </article>
  );
}

export function AppRow({
  app,
  snapshot,
  recentlyUpdated
}: {
  app: AppRecord;
  snapshot: BaselineSnapshot;
  recentlyUpdated: boolean;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const {
    update,
    isIgnored,
    uninstallableItem,
    isUninstalling,
    actionState,
    isUpdating,
    homebrewUninstallBlocked,
    isHomebrewUpdatePinned
  } = appControlState(app, snapshot);
  const recentlyUpdatedRecord = recentlyUpdated
    ? snapshot.recentlyUpdated.find((record) => record.appID === app.id)
    : undefined;
  const recentlyUpdatedAt = recentlyUpdatedRecord?.updatedAt;
  const label = appSourceLabel(app, snapshot, recentlyUpdatedRecord);

  return (
    <article className={isIgnored ? "row ignored-row" : "row"}>
      <AppIconButton app={app} />
      <div className="row-main">
        <div className="row-title">
          <strong>{app.displayName}</strong>
          {label && <span>{label}</span>}
          {isHomebrewUpdatePinned && (
            <span title="Pinned in Homebrew; unpin in Homebrew to update.">Pinned in Homebrew</span>
          )}
        </div>
        <p>
          {update ? (
            <VersionChange
              from={appUpdateVersionChange(update).from}
              to={appUpdateVersionChange(update).to}
            />
          ) : recentlyUpdatedAt ? (
            updatedRelativeLabel(recentlyUpdatedAt)
          ) : (
            app.localVersion.raw || "unknown"
          )}
        </p>
        <AppProviderStatus snapshot={snapshot} app={app} />
        <AdminPasswordStatus snapshot={snapshot} app={app} />
      </div>
      <div className="row-actions">
        {update && !isHomebrewUpdatePinned && (
          <UpdateActionButton
            state={actionState}
            disabled={isUninstalling}
            readyLabel={appUpdateReadyLabel(app, snapshot, update)}
            onAction={() => void baseline.performAppUpdate(app.id)}
          />
        )}
        <RowMoreActionButton
          isIgnored={isIgnored}
          disabled={isUninstalling}
          onToggleIgnore={() => void baseline.toggleIgnoredApp(app.id)}
          uninstallLabel="Uninstall"
          canUninstall={Boolean(uninstallableItem)}
          uninstalling={isUninstalling}
          uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
          onUninstall={() =>
            uninstallableItem &&
            requestActionConfirmation({ type: "uninstall", item: uninstallableItem })
          }
        />
      </div>
    </article>
  );
}

export function DiscoverRow({
  item,
  snapshot
}: {
  item: HomebrewCaskDiscoveryItem;
  snapshot: BaselineSnapshot;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const installing = snapshot.homebrewDiscoverInstallingItemIDs.includes(item.id);
  const failed = snapshot.homebrewDiscoverFailedItemIDs.includes(item.id);
  const done = snapshot.homebrewDiscoverInstalledPendingRefreshItemIDs.includes(item.id);
  const progress = snapshot.homebrewDiscoverProgressByItemID[item.id];
  const canInstall = snapshot.isHomebrewInstalled && !snapshot.homebrewConfigurationBlocked;
  const busy = canInstall && !installing && !failed && !done && isHomebrewCommandActive(snapshot);

  return (
    <article className="row">
      <HomebrewItemIcon item={item} snapshot={snapshot} />
      <div className="row-main">
        <div className="row-title">
          <strong>{item.displayName}</strong>
          <span>{homebrewPresentationLabel(item.kind, item.presentation)}</span>
        </div>
        <p>
          {snapshot.homebrewConfigurationBlocked
            ? "Homebrew configuration needs attention. Check Update Tools in Settings."
            : snapshot.isHomebrewInstalled
              ? item.version.raw || item.token
              : "Homebrew is not installed. Install Homebrew to enable this source."}
        </p>
        <AdminPasswordStatus snapshot={snapshot} itemID={item.id} />
      </div>
      <div className="row-actions">
        <UpdateActionButton
          state={actionStateFromFlags({
            failed,
            updating: installing,
            progress,
            done,
            waitingForAdmin: isWaitingForAdmin(snapshot, { itemID: item.id })
          })}
          readyLabel={
            snapshot.homebrewConfigurationBlocked
              ? "Check Homebrew"
              : canInstall
                ? busy
                  ? "Busy"
                  : "Install"
                : "Needs Homebrew"
          }
          disabled={!canInstall || busy}
          onAction={() => {
            if (canInstall && !busy) {
              requestActionConfirmation({ type: "install", item });
            }
          }}
        />
        {item.homepageURL && (
          <button
            className="icon-button"
            onClick={() => void baseline.openExternal(item.homepageURL!)}
            title="Open Homebrew page"
            aria-label="Open Homebrew page"
          >
            <Link2 size={15} />
          </button>
        )}
      </div>
    </article>
  );
}

export function HomebrewUpdateCard({
  item,
  snapshot
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const { isUpdating, isUninstalling, isIgnored, updateState, homebrewUninstallBlocked } =
    homebrewControlState(item, snapshot);

  return (
    <article className={isIgnored ? "item-card update-card ignored-row" : "item-card update-card"}>
      <div className="item-card-top">
        <HomebrewItemIcon item={item} snapshot={snapshot} />
        <div className="item-card-actions">
          {item.isOutdated && !item.pinned && (
            <UpdateActionButton
              state={updateState}
              disabled={isUninstalling}
              onAction={() => void baseline.performHomebrewUpdate(item.id)}
            />
          )}
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            onToggleIgnore={() => void baseline.toggleIgnoredHomebrew(item.id)}
            uninstallLabel="Uninstall"
            canUninstall={item.kind === "cask"}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() => requestActionConfirmation({ type: "uninstall", item })}
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          {item.pinned && (
            <span title="Pinned in Homebrew; unpin in Homebrew to update.">Pinned in Homebrew</span>
          )}
          <span>{homebrewPresentationLabel(item.kind, item.presentation)}</span>
        </div>
        <p>
          {item.latestVersion ? (
            <VersionChange
              from={item.installedVersion.raw || "unknown"}
              to={item.latestVersion.raw}
              collapseLong
            />
          ) : (
            item.installedVersion.raw || "unknown"
          )}
        </p>
        <AdminPasswordStatus snapshot={snapshot} itemID={item.id} />
      </div>
    </article>
  );
}

export function RecentHomebrewCard({
  item,
  snapshot,
  appCaskLabel
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
  appCaskLabel?: string;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const { isUpdating, isUninstalling, isIgnored, updateState, homebrewUninstallBlocked } =
    homebrewControlState(item, snapshot);
  const recentlyUpdatedRecord = snapshot.homebrewRecentlyUpdated.find(
    (record) => record.itemID === item.id
  );

  return (
    <article className={isIgnored ? "item-card recent-card ignored-row" : "item-card recent-card"}>
      <div className="item-card-top">
        <HomebrewItemIcon item={item} snapshot={snapshot} />
        <div className="item-card-actions">
          {item.isOutdated && !item.pinned && (
            <UpdateActionButton
              state={updateState}
              disabled={isUninstalling}
              onAction={() => void baseline.performHomebrewUpdate(item.id)}
            />
          )}
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            onToggleIgnore={() => void baseline.toggleIgnoredHomebrew(item.id)}
            uninstallLabel="Uninstall"
            canUninstall={item.kind === "cask"}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() => requestActionConfirmation({ type: "uninstall", item })}
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          {item.pinned && (
            <span title="Pinned in Homebrew; unpin in Homebrew to update.">Pinned in Homebrew</span>
          )}
          <span>{homebrewItemLabel(item, appCaskLabel)}</span>
        </div>
        <p>
          {recentlyUpdatedRecord
            ? updatedRelativeLabel(recentlyUpdatedRecord.updatedAt)
            : "Updated recently"}
        </p>
        <AdminPasswordStatus snapshot={snapshot} itemID={item.id} />
      </div>
    </article>
  );
}

export function IgnoredHomebrewCard({
  item,
  snapshot
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const { isUpdating, isUninstalling, isIgnored, updateState, homebrewUninstallBlocked } =
    homebrewControlState(item, snapshot);

  return (
    <article className="item-card ignored-card ignored-row">
      <div className="item-card-top">
        <HomebrewItemIcon item={item} snapshot={snapshot} />
        <div className="item-card-actions">
          <RowMoreActionButton
            isIgnored={isIgnored}
            disabled={isUninstalling}
            updateAction={
              item.isOutdated && !item.pinned
                ? {
                    state: updateState,
                    disabled: isUninstalling,
                    onAction: () => void baseline.performHomebrewUpdate(item.id)
                  }
                : undefined
            }
            onToggleIgnore={() => void baseline.toggleIgnoredHomebrew(item.id)}
            uninstallLabel="Uninstall"
            canUninstall={item.kind === "cask"}
            uninstalling={isUninstalling}
            uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
            onUninstall={() => requestActionConfirmation({ type: "uninstall", item })}
          />
        </div>
      </div>
      <div className="item-card-main row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          {item.pinned && (
            <span title="Pinned in Homebrew; unpin in Homebrew to update.">Pinned in Homebrew</span>
          )}
          <span>{homebrewPresentationLabel(item.kind, item.presentation)}</span>
        </div>
        <p>
          {item.latestVersion ? (
            <VersionChange
              from={item.installedVersion.raw || "unknown"}
              to={item.latestVersion.raw}
              collapseLong
            />
          ) : (
            item.installedVersion.raw || "unknown"
          )}
        </p>
        <AdminPasswordStatus snapshot={snapshot} itemID={item.id} />
      </div>
    </article>
  );
}

export function HomebrewRow({
  item,
  snapshot,
  recentlyUpdated = false
}: {
  item: HomebrewManagedItem;
  snapshot: BaselineSnapshot;
  recentlyUpdated?: boolean;
}) {
  const requestActionConfirmation = React.useContext(ActionConfirmationContext);
  const { isUpdating, isUninstalling, isIgnored, updateState, homebrewUninstallBlocked } =
    homebrewControlState(item, snapshot);
  const recentlyUpdatedAt = recentlyUpdated
    ? snapshot.homebrewRecentlyUpdated.find((record) => record.itemID === item.id)?.updatedAt
    : undefined;

  return (
    <article className={isIgnored ? "row ignored-row" : "row"}>
      <HomebrewItemIcon item={item} snapshot={snapshot} />
      <div className="row-main">
        <div className="row-title">
          <strong>{item.name}</strong>
          {item.pinned && (
            <span title="Pinned in Homebrew; unpin in Homebrew to update.">Pinned in Homebrew</span>
          )}
          <span>{homebrewPresentationLabel(item.kind, item.presentation)}</span>
        </div>
        <p>
          {recentlyUpdatedAt ? (
            updatedRelativeLabel(recentlyUpdatedAt)
          ) : item.latestVersion ? (
            <VersionChange
              from={item.installedVersion.raw || "unknown"}
              to={item.latestVersion.raw}
            />
          ) : (
            item.installedVersion.raw || "unknown"
          )}
        </p>
        <AdminPasswordStatus snapshot={snapshot} itemID={item.id} />
      </div>
      <div className="row-actions">
        {item.isOutdated && !item.pinned && (
          <UpdateActionButton
            state={updateState}
            disabled={isUninstalling}
            onAction={() => void baseline.performHomebrewUpdate(item.id)}
          />
        )}
        <RowMoreActionButton
          isIgnored={isIgnored}
          disabled={isUninstalling}
          onToggleIgnore={() => void baseline.toggleIgnoredHomebrew(item.id)}
          uninstallLabel="Uninstall"
          canUninstall={item.kind === "cask"}
          uninstalling={isUninstalling}
          uninstallDisabled={isUpdating || isUninstalling || homebrewUninstallBlocked}
          onUninstall={() => requestActionConfirmation({ type: "uninstall", item })}
        />
      </div>
    </article>
  );
}

export function HomebrewItemIcon({
  item,
  snapshot
}: {
  item: Pick<HomebrewManagedItem, "kind" | "token" | "presentation"> &
    Partial<
      Pick<HomebrewManagedItem, "appID" | "name" | "iconDataURL"> &
        Pick<HomebrewCaskDiscoveryItem, "displayName">
    >;
  snapshot: BaselineSnapshot;
}) {
  const app = matchingAppForHomebrewItem(item, snapshot);
  const iconDataURL = item.iconDataURL ?? app?.iconDataURL;
  const isCaskItem = isCask(item.kind);
  const isCliLike = item.kind === "formula" || item.presentation === "cli";
  const fallbackIcon = isCliLike ? <Terminal size={25} strokeWidth={2.2} /> : <Package size={26} />;
  const fallbackClassName = [
    "app-icon",
    "brew",
    isCaskItem ? "cask" : "formula",
    isCliLike ? "tool" : undefined
  ]
    .filter(Boolean)
    .join(" ");

  if (app) {
    return (
      <button
        className={
          iconDataURL
            ? "app-icon app-icon-image clickable-app-icon"
            : `${fallbackClassName} clickable-app-icon`
        }
        onClick={() => void baseline.openApp(app.id)}
        title="Open app"
        aria-label="Open app"
      >
        {iconDataURL ? <img src={iconDataURL} alt="" draggable={false} /> : fallbackIcon}
      </button>
    );
  }

  if (iconDataURL) {
    return (
      <div className="app-icon app-icon-image">
        <img src={iconDataURL} alt="" draggable={false} />
      </div>
    );
  }

  return <div className={fallbackClassName}>{fallbackIcon}</div>;
}

function AdminPasswordStatus({
  snapshot,
  itemID,
  app
}: {
  snapshot: BaselineSnapshot;
  itemID?: string;
  app?: AppRecord;
}) {
  const waiting = app
    ? appIsWaitingForAdmin(app, snapshot)
    : isWaitingForAdmin(snapshot, { itemID });
  return waiting ? <p role="status">Waiting for admin password</p> : null;
}

function AppProviderStatus({ snapshot, app }: { snapshot: BaselineSnapshot; app: AppRecord }) {
  const check = snapshot.appProviderChecks?.[app.id];
  const label = appCheckLabel(check);
  if (!label) return null;
  return (
    <p className="app-provider-status">
      {label}
      {check?.status === "unresolved" && check.discoveryCheckedAt && (
        <> · Source search: {new Date(check.discoveryCheckedAt).toLocaleString()}</>
      )}
      {check?.status === "failed" && check.checkedAt && (
        <> · Last successful check: {new Date(check.checkedAt).toLocaleString()}</>
      )}
    </p>
  );
}
