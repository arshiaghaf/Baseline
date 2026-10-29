// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { permissionGuideActions } from "../shared/permissionGuide";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { ipcChannels, type BaselineAPI } from "../shared/ipc";
import {
  isBoolean,
  isPlainRecord,
  isPreferencePatch,
  isString,
  isStringArray,
  type ValueValidator
} from "./preferenceValidation";

type InvokeMethod = Exclude<keyof BaselineAPI, "onSnapshotChanged" | "onSnapshotProgress">;
const optional =
  (validate: ValueValidator): ValueValidator =>
  (value) =>
    value === undefined || validate(value);

const notesString: ValueValidator = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  ![...value].some((character) => character.charCodeAt(0) < 32);

function record(fields: Record<string, ValueValidator>): ValueValidator {
  return (value) =>
    isPlainRecord(value) &&
    Object.keys(value).every((key) => Object.hasOwn(fields, key)) &&
    Object.entries(fields).every(([key, validate]) => validate(value[key]));
}

const discoveryItem = record({
  id: isString,
  kind: (value) => value === "cask" || value === "formula",
  token: isString,
  displayName: isString,
  presentation: optional(
    (value) =>
      typeof value === "string" && ["formula", "app", "cli", "package", "cask"].includes(value)
  ),
  version: record({ raw: isString }),
  homepageURL: optional(isString)
});

// Exhaustive across the public invoke API; event subscriptions never register handlers.
const argumentValidators: Record<InvokeMethod, ValueValidator[]> = {
  permissionGuide: [
    (value) =>
      typeof value === "string" && (permissionGuideActions as readonly string[]).includes(value)
  ],
  getSnapshot: [],
  getReleaseNotes: [
    record({
      requestID: notesString,
      target: record({
        kind: (value) => value === "app" || value === "homebrew",
        id: notesString,
        version: notesString,
        buildVersion: optional(notesString)
      }),
      force: optional(isBoolean)
    })
  ],
  cancelReleaseNotes: [notesString],
  getAppMetadata: [],
  checkForBaselineUpdates: [],
  getDiagnostics: [],
  collectHomebrewDiagnostics: [
    optional(record({ doctor: optional(isBoolean), services: optional(isBoolean) }))
  ],
  getHomebrewInstalledContext: [isString],
  getToolStatus: [],
  refreshToolStatus: [],
  cleanUpHomebrew: [],
  refresh: [optional(isBoolean), optional(isBoolean)],
  setSearchText: [isString],
  setSelectedTab: [
    (value) =>
      typeof value === "string" &&
      ["all", "apps", "homebrew", "installed", "ignored"].includes(value)
  ],
  updatePreferences: [isPreferencePatch],
  acknowledgeProfileStatsReset: [],
  dismissOperationFailure: [isString],
  toggleIgnoredApp: [isString],
  toggleIgnoredHomebrew: [isString],
  performAppUpdate: [isString],
  performHomebrewUpdate: [isString],
  performHomebrewUpdateAll: [optional(isStringArray)],
  installHomebrewItem: [discoveryItem],
  uninstallHomebrewItem: [isString],
  openApp: [isString],
  openExternal: [isString],
  chooseDirectory: [],
  removeDirectory: [isString],
  copyOperationFailure: [isString, isString],
  copyDiagnostics: [],
  showMainWindow: [],
  showSettings: []
};

export function backendIpcRegistrar(
  ipc: Pick<IpcMain, "handle">,
  requireSender: (event: IpcMainInvokeEvent) => void
) {
  return function handle<K extends InvokeMethod>(
    method: K,
    listener: (event: IpcMainInvokeEvent, ...args: Parameters<BaselineAPI[K]>) => unknown
  ): void {
    ipc.handle(ipcChannels[method], (event, ...args: unknown[]) => {
      requireSender(event);
      const validators = argumentValidators[method];
      if (args.length > validators.length || !validators.every((validate, i) => validate(args[i])))
        throw new Error("Invalid IPC arguments");
      return listener(event, ...(args as Parameters<BaselineAPI[K]>));
    });
  };
}
