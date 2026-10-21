// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { PermissionGuide } from "./components/PermissionGuide";
import { baseline } from "./ipc";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BaselineSnapshot } from "../shared/domain";
import { defaultPersistedSnapshot, applySnapshotProgress } from "../shared/domain";
import "./styles.css";
import type { Route } from "./types";
import { SettingsView } from "./components/SettingsView";
import { Dashboard } from "./components/Dashboard";

const initialSnapshot: BaselineSnapshot = {
  ...defaultPersistedSnapshot(),
  isMasInstalled: false,
  isHomebrewInstalled: false,
  isChecking: true,
  isRefreshing: false,
  searchText: "",
  isRunningHomebrewMaintenance: false,
  isHomebrewCommandLocked: false,
  isHomebrewCleanupLocked: false,
  isCleaningUpHomebrew: false,
  appUpdatingIDs: [],
  appUpdatedPendingRefreshIDs: [],
  homebrewUpdatingItemIDs: [],
  homebrewQueuedItemIDs: [],
  homebrewUninstallingItemIDs: [],
  homebrewUpdatedPendingRefreshItemIDs: [],
  homebrewBatchProgressByItemID: {},
  homebrewBatchFailedItemIDs: [],
  homebrewFallbackProgressByAppID: {},
  homebrewFallbackFailedAppIDs: [],
  homebrewDiscoverItems: [],
  homebrewDiscoverInstallingItemIDs: [],
  homebrewDiscoverInstalledPendingRefreshItemIDs: [],
  homebrewDiscoverFailedItemIDs: [],
  homebrewDiscoverProgressByItemID: {},
  laggingHomebrewCaskTokens: [],
  defaultScanDirectories: []
};

export function App() {
  const [snapshot, setSnapshot] = useState<BaselineSnapshot>(initialSnapshot);
  const [route, setRoute] = useState<Route>(currentRoute());
  const [searchActive, setSearchActive] = useState(false);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const introductionShown = useRef(false);
  const previousSearchTextRef = useRef(initialSnapshot.searchText);

  useEffect(() => {
    let current = initialSnapshot;
    let disposed = false;
    let resyncing = false;
    let resyncNeeded = false;
    const receiveSnapshot = (next: BaselineSnapshot) => {
      if (
        disposed ||
        (next.snapshotRevision !== undefined &&
          current.snapshotRevision !== undefined &&
          next.snapshotRevision < current.snapshotRevision)
      )
        return;
      current = next;
      setSnapshot(next);
      setSnapshotLoaded(true);
    };
    const resync = () => {
      if (resyncing) {
        resyncNeeded = true;
        return;
      }
      resyncing = true;
      void baseline
        .getSnapshot()
        .then(receiveSnapshot)
        .catch(() => undefined)
        .finally(() => {
          resyncing = false;
          if (resyncNeeded && !disposed) {
            resyncNeeded = false;
            resync();
          }
        });
    };
    const unsubscribeSnapshot = baseline.onSnapshotChanged(receiveSnapshot);
    const unsubscribeProgress = baseline.onSnapshotProgress((event) => {
      const result = applySnapshotProgress(current, event);
      if (result.needsResync) {
        resync();
        return;
      }
      receiveSnapshot(result.snapshot);
    });
    resync();
    return () => {
      disposed = true;
      unsubscribeSnapshot();
      unsubscribeProgress();
    };
  }, []);

  useEffect(() => {
    const previousSearchText = previousSearchTextRef.current;
    previousSearchTextRef.current = snapshot.searchText;
    if (route === "menubar" && !previousSearchText.trim() && snapshot.searchText.trim()) {
      setSearchActive(true);
    }
  }, [route, snapshot.searchText]);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (
      route !== "main" ||
      !snapshotLoaded ||
      snapshot.updateIntroductionDismissed ||
      introductionShown.current
    )
      return;
    introductionShown.current = true;
    void baseline.permissionGuide("show").catch(() => {});
  }, [route, snapshotLoaded, snapshot.updateIntroductionDismissed]);

  if (route === "permission-guide") return <PermissionGuide />;

  if (route === "settings") {
    return <SettingsView snapshot={snapshot} />;
  }

  return (
    <Dashboard
      snapshot={snapshot}
      compact={route === "menubar"}
      searchActive={searchActive}
      onSearchActiveChange={setSearchActive}
      onOpenSettings={() => {
        setSearchActive(false);
        void baseline.showSettings();
      }}
    />
  );
}

function currentRoute(): Route {
  const raw = window.location.hash.replace(/^#\/?/u, "");
  if (raw === "menubar" || raw === "settings" || raw === "permission-guide") {
    return raw;
  }
  return "main";
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<App />);
}

export { Dashboard } from "./components/Dashboard";

export { OperationFailures } from "./components/OperationFailures";

export { AppRow, DiscoverRow, HomebrewRow } from "./components/ItemViews";

export { HomebrewSection } from "./components/DashboardContent";

export { UpdateActionButton } from "./components/CommonControls";

export { SettingsView } from "./components/SettingsView";

export { ActionConfirmationContext } from "./components/ActionConfirmation";

export { actionStateFromFlags } from "./helpers/actionState";

export { uninstallableHomebrewItemForApp } from "./helpers/sections";

export type { ActionConfirmation, ActionState } from "./types";
