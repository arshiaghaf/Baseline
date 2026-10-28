// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createHash, randomUUID } from "node:crypto";
import type { BaselineSnapshot } from "../shared/domain";
import { homebrewCommandToken } from "../shared/homebrewIdentity";
import { compareVersions } from "../shared/version";
import { renderDiagnostics } from "../shared/diagnostics";
import {
  CLIError,
  cliExit,
  validateCLIRequest,
  type CLIOperation,
  type CLIRequest,
  type CLIResponse,
  type CLITarget
} from "../shared/cli";
import type { UpdateStore } from "./updateStore";
import { isMacOSManagedApp } from "./macOSManagedApps";

type Store = Pick<
  UpdateStore,
  | "getSnapshot"
  | "hasActiveUpdateOperation"
  | "refreshToolStatus"
  | "refresh"
  | "performHomebrewUpdate"
  | "performCLIAppHandoff"
>;
const freshnessMS = 15 * 60_000;

/** One facade over the GUI store. No second inventory, command runner or persistence. */
export class CLIService {
  readonly sessionID = randomUUID();
  private operations = new Map<string, { fingerprint: string; operation: CLIOperation }>();
  private active?: CLIOperation;
  private closing = false;
  private explicitCheckAtMS: number | undefined;
  constructor(
    private store: Store,
    private version: string,
    private now = () => Date.now()
  ) {}

  close(): void {
    this.closing = true;
  }

  async handle(input: unknown): Promise<CLIResponse> {
    try {
      const request = validateCLIRequest(input);
      if (this.closing)
        throw new CLIError(
          "closing",
          "Baseline is quitting. Retry after it restarts.",
          cliExit.unavailable
        );
      const data = this.dispatch(request);
      return { schemaVersion: 1, sessionID: this.sessionID, ok: true, exitCode: 0, data };
    } catch (error) {
      const e =
        error instanceof CLIError
          ? error
          : new CLIError(
              "internal",
              "Baseline could not complete the request. Run baseline doctor."
            );
      return {
        schemaVersion: 1,
        sessionID: this.sessionID,
        ok: false,
        exitCode: e.exitCode,
        error: { code: e.code, message: e.message }
      };
    }
  }

  private dispatch(r: CLIRequest): unknown {
    const snapshot = this.store.getSnapshot();
    if (r.command === "status")
      return {
        version: this.version,
        backendPID: process.pid,
        ...this.health(snapshot),
        operation: this.active && this.operationView(this.active)
      };
    if (r.command === "doctor")
      return {
        ...this.health(snapshot),
        diagnostics: renderDiagnostics(snapshot, this.version),
        capabilities: {
          commands: ["status", "list", "inspect", "check", "update", "operation", "doctor"],
          maxTargets: 50,
          directUpdates: ["homebrew"],
          handoffs: ["sparkle", "appStore", "web"],
          interactiveCasks: true,
          selfUpdate: "Use Baseline’s signed self-updater in the app.",
          cancellation: "Stops waiting; accepted work continues in Baseline.",
          operationRetention:
            "Last 128 operations in this app session; unknown IDs never authorize retries."
        },
        exitCodes: cliExit
      };
    if (r.command === "list") return { ...this.health(snapshot), targets: this.targets(snapshot) };
    if (r.command === "inspect")
      return { ...this.health(snapshot), target: this.findTargets(snapshot, r.ids!)[0] };
    if (r.command === "operation") {
      const entry = this.operations.get(r.operationID!);
      if (!entry)
        throw new CLIError(
          "unknown-operation",
          "Operation not found in this app session. Its outcome may be unknown; inspect installed state before retrying.",
          cliExit.unavailable
        );
      return { operation: this.operationView(entry.operation) };
    }
    if (r.command === "update" && r.dryRun) return this.plan(snapshot, r.ids!);
    const id = r.operationID ?? randomUUID();
    const fingerprint = JSON.stringify({
      command: r.command,
      ids: r.ids,
      dryRun: r.dryRun === true,
      yes: r.yes === true,
      interactive: r.interactive === true,
      expectPlan: r.expectPlan
    });
    const previous = this.operations.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new CLIError(
          "operation-conflict",
          "This operation ID already names a different request.",
          cliExit.usage
        );
      return { operation: this.operationView(previous.operation) };
    }
    if (this.active || snapshot.isRefreshing || this.store.hasActiveUpdateOperation())
      throw new CLIError(
        "busy",
        "Baseline is checking or changing software. Wait for it to finish.",
        cliExit.busy
      );
    let plan: ReturnType<CLIService["plan"]> | undefined;
    if (r.command === "update") {
      if (r.yes !== true)
        throw new CLIError(
          "confirmation-required",
          "Preview with --dry-run, then pass --yes to apply these exact targets.",
          cliExit.usage
        );
      plan = this.plan(snapshot, r.ids!);
      if (r.expectPlan && r.expectPlan !== plan.planID)
        throw new CLIError(
          "stale-plan",
          "The update plan changed. Preview it again before applying.",
          cliExit.busy
        );
    }
    const operation: CLIOperation = {
      id,
      kind: r.command as "check" | "update",
      state: "running",
      startedAt: new Date(this.now()).toISOString(),
      results: [],
      exitCode: 0
    };
    // Keep active operations and the last completed ones; never evict a running ID.
    while (this.operations.size >= 128)
      this.operations.delete(this.operations.keys().next().value!);
    this.operations.set(id, { fingerprint, operation });
    this.active = operation;
    // Reserve admission synchronously before starting asynchronous work.
    void this.run(operation, r, plan).catch(() => undefined);
    return { operation: this.operationView(operation) };
  }

  private health(s: BaselineSnapshot) {
    return {
      cached: true,
      checkedThisSession: this.explicitCheckAtMS !== undefined,
      lastExplicitCheckAt:
        this.explicitCheckAtMS === undefined
          ? null
          : new Date(this.explicitCheckAtMS).toISOString(),
      lastRefreshAt: s.lastRefreshDate ?? null,
      refreshing: s.isRefreshing,
      refreshFailed: s.refreshCheckFailed === true,
      homebrewCheckStatus: s.homebrewCheckStatus ?? "unknown",
      notices: [
        s.refreshErrorMessage,
        s.lastRefreshNoticeMessage,
        s.homebrewCheckNoticeMessage
      ].filter(Boolean),
      freshForUpdates: this.fresh(s)
    };
  }

  private fresh(s: BaselineSnapshot): boolean {
    const elapsed = this.now() - (this.explicitCheckAtMS ?? NaN);
    return (
      this.explicitCheckAtMS !== undefined &&
      !s.isRefreshing &&
      !s.refreshCheckFailed &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < freshnessMS
    );
  }

  private targets(s: BaselineSnapshot): CLITarget[] {
    const apps: CLITarget[] = s.apps.map((app) => {
      const update = s.updates.find((u) => u.appID === app.id);
      const ignored = s.ignoredIDs.includes(app.id);
      const self = app.bundleIdentifier?.toLowerCase() === "com.arshiaghaf.baseline";
      const selectedCask =
        update?.source === "homebrew"
          ? s.homebrewItems.find(
              (item) =>
                item.kind === "cask" &&
                item.token.toLowerCase() === update.homebrewToken?.toLowerCase()
            )
          : undefined;
      const pinned = selectedCask?.pinned === true;
      const ignoredRoute = Boolean(
        selectedCask && s.ignoredHomebrewItemIDs.includes(selectedCask.id)
      );
      const blocked = ignored || ignoredRoute || pinned || self || isMacOSManagedApp(app);
      return {
        id: `app:${app.id}`,
        kind: "app",
        name: app.displayName,
        installedVersion: app.localVersion.raw,
        availableVersion: update?.remoteVersion.raw,
        source: update?.source ?? app.sourceHint,
        checkedAt: s.appProviderChecks?.[app.id]?.checkedAt ?? update?.checkedAt,
        checkStatus: s.appProviderChecks?.[app.id]?.status ?? "unknown",
        ignored,
        pinned,
        action: blocked ? "blocked" : update ? "requires-user-action" : "none",
        reason: self
          ? "Use Baseline’s signed self-updater."
          : ignored || ignoredRoute
            ? "Ignored in Baseline."
            : pinned
              ? "Pinned in Homebrew."
              : isMacOSManagedApp(app)
                ? "Managed by macOS."
                : update
                  ? "Finish this update in the app or publisher’s updater. This CLI does not install it."
                  : undefined
      };
    });
    const packages: CLITarget[] = s.homebrewItems.map((item) => {
      const ignored =
        s.ignoredHomebrewItemIDs.includes(item.id) ||
        Boolean(item.appID && s.ignoredIDs.includes(item.appID));
      const unverifiable =
        item.isOutdated &&
        (!item.latestVersion || compareVersions(item.latestVersion, item.installedVersion) <= 0);
      const blocked =
        ignored ||
        item.pinned ||
        item.isSelf ||
        !homebrewCommandToken(item) ||
        s.homebrewConfigurationBlocked ||
        s.isHomebrewCleanupLocked;
      return {
        id: `brew:${item.id}`,
        kind: item.kind,
        name: item.name,
        installedVersion: item.installedVersion.raw,
        availableVersion: item.isOutdated ? item.latestVersion?.raw : undefined,
        source: "homebrew",
        checkedAt: s.lastRefreshDate,
        checkStatus: s.homebrewCheckStatus ?? "unknown",
        ignored,
        pinned: item.pinned === true,
        linkedTargetID: item.appID ? `app:${item.appID}` : undefined,
        action: blocked
          ? "blocked"
          : unverifiable
            ? "requires-user-action"
            : item.isOutdated
              ? "update"
              : "none",
        reason: ignored
          ? "Ignored in Baseline."
          : item.pinned
            ? "Pinned in Homebrew."
            : item.isSelf
              ? "Use Baseline’s signed self-updater."
              : !homebrewCommandToken(item)
                ? "Installed identity is unverified."
                : blocked
                  ? "Homebrew is blocked; inspect baseline doctor."
                  : unverifiable
                    ? "This update has no independently verifiable version increase. Complete it in Baseline’s app; the CLI will not start it."
                    : undefined
      };
    });
    return [...apps, ...packages].sort((a, b) => a.id.localeCompare(b.id));
  }

  private findTargets(s: BaselineSnapshot, ids: string[]): CLITarget[] {
    const targets = this.targets(s);
    return ids.map((id) => {
      const target = targets.find((t) => t.id === id);
      if (!target)
        throw new CLIError(
          "unknown-target",
          "Target not found. Copy an exact ID from baseline list; names and package tokens are not accepted.",
          cliExit.usage
        );
      return target;
    });
  }

  private plan(s: BaselineSnapshot, ids: string[]) {
    const targets = this.findTargets(s, ids);
    const evidence = targets.map((target) => this.targetEvidence(s, target));
    const planID = createHash("sha256")
      .update(JSON.stringify({ session: this.sessionID, targets, evidence, fresh: this.fresh(s) }))
      .digest("hex");
    return {
      planID,
      ...this.health(s),
      targets,
      targetEvidence: evidence,
      effects:
        "Homebrew updates may update dependencies and perform Homebrew’s normal cleanup. Casks and external handoffs require --interactive. No installation-wide cleanup or self-update is performed."
    };
  }

  private targetEvidence(s: BaselineSnapshot, target: CLITarget): string {
    const record =
      target.kind === "app"
        ? s.apps.find((app) => `app:${app.id}` === target.id)
        : s.homebrewItems.find((item) => `brew:${item.id}` === target.id);
    const identity: Record<string, unknown> = { ...record };
    delete identity.iconDataURL;
    return createHash("sha256")
      .update(
        JSON.stringify({
          identity,
          update:
            target.kind === "app"
              ? s.updates.find((update) => `app:${update.appID}` === target.id)
              : undefined,
          ignored: target.ignored,
          pinned: target.pinned,
          action: target.action
        })
      )
      .digest("hex");
  }

  private operationView(operation: CLIOperation): CLIOperation {
    const waiting =
      !operation.finishedAt && this.store.getSnapshot().homebrewOperation?.phase === "waiting";
    return structuredClone({ ...operation, state: waiting ? "waiting-for-user" : operation.state });
  }

  private async run(
    op: CLIOperation,
    r: CLIRequest,
    plan?: ReturnType<CLIService["plan"]>
  ): Promise<void> {
    try {
      if (op.kind === "check") {
        this.explicitCheckAtMS = undefined;
        const startedAtMS = this.now();
        await this.store.refreshToolStatus();
        await this.store.refresh(false, { forceMetadata: true });
        const s = this.store.getSnapshot();
        if (
          !s.refreshCheckFailed &&
          !s.isRefreshing &&
          Date.parse(s.lastRefreshDate ?? "") >= startedAtMS
        )
          this.explicitCheckAtMS = this.now();
        const incomplete =
          this.explicitCheckAtMS === undefined ||
          s.refreshCheckFailed ||
          s.isRefreshing ||
          s.homebrewCheckStatus === "incomplete" ||
          Object.values(s.appProviderChecks ?? {}).some((check) =>
            ["failed", "pending"].includes(check.status)
          );
        op.state = incomplete ? "partial" : "succeeded";
        op.exitCode = incomplete ? cliExit.failed : cliExit.success;
        op.message = incomplete
          ? "Some sources could not be checked. Inspect list and doctor for freshness and notices."
          : "Check complete. List results to see available updates and handoffs.";
      } else {
        for (const [index, target] of plan!.targets.entries()) {
          try {
            const snapshot = this.store.getSnapshot();
            const current = this.findTargets(snapshot, [target.id])[0]!;
            if (this.targetEvidence(snapshot, current) !== plan!.targetEvidence[index]) {
              op.results.push({
                id: target.id,
                status: "blocked",
                message:
                  "Target identity, version, route or protection changed. Preview a new plan before retrying."
              });
              continue;
            }
            if (snapshot.isRefreshing || this.store.hasActiveUpdateOperation()) {
              op.results.push({
                id: target.id,
                status: "blocked",
                message: "Other app work started. Wait for it to finish and preview again."
              });
              continue;
            }
            if (current.action === "blocked" || current.action === "none") {
              op.results.push({
                id: target.id,
                status: "blocked",
                message: current.reason ?? "No update is available."
              });
              continue;
            }
            if (!this.fresh(snapshot)) {
              op.results.push({
                id: target.id,
                status: "blocked",
                message:
                  "Run baseline check before updating; results must be fresh in this session."
              });
              continue;
            }
            if (target.kind !== "app" && current.action === "requires-user-action") {
              op.results.push({
                id: target.id,
                status: "requires-user-action",
                message: current.reason
              });
              continue;
            }
            if (target.kind === "app") {
              const elapsed = this.now() - Date.parse(current.checkedAt ?? "");
              if (
                ["failed", "pending"].includes(current.checkStatus ?? "") ||
                !Number.isFinite(elapsed) ||
                elapsed < 0 ||
                elapsed >= freshnessMS
              ) {
                op.results.push({
                  id: target.id,
                  status: "blocked",
                  message:
                    "This app's update source could not be freshly checked. Check again before opening a handoff."
                });
                continue;
              }
              if (r.interactive) await this.store.performCLIAppHandoff(target.id.slice(4));
              op.results.push({
                id: target.id,
                status: "requires-user-action",
                message: r.interactive
                  ? "Handoff opened. Installation is not confirmed; finish it in the target app or publisher’s updater."
                  : "Repeat with --interactive to open the handoff, then finish the update there."
              });
              continue;
            }
            if (snapshot.homebrewCheckStatus !== "complete") {
              op.results.push({
                id: target.id,
                status: "blocked",
                message: "Homebrew inventory is incomplete. Check again before updating."
              });
              continue;
            }
            if (target.kind === "cask" && !r.interactive) {
              op.results.push({
                id: target.id,
                status: "requires-user-action",
                message:
                  "Cask updates may need administrator authorization. Repeat with --interactive at the Mac."
              });
              continue;
            }
            // Existing store revalidates membership, canonical identity, pins and locks
            // immediately before the command, and reconciles before it resolves.
            await this.store.performHomebrewUpdate(target.id.slice(5));
            const after = this.store.getSnapshot();
            const item = after.homebrewItems.find((i) => `brew:${i.id}` === target.id);
            const failure = after.operationFailures?.find(
              (f) => f.entityID === target.id.slice(5) && f.operation === "update"
            );
            const verified =
              !failure &&
              after.homebrewCheckStatus === "complete" &&
              item &&
              !item.isOutdated &&
              compareVersions(item.installedVersion, target.installedVersion) > 0 &&
              target.availableVersion !== undefined &&
              compareVersions(item.installedVersion, target.availableVersion) >= 0;
            op.results.push({
              id: target.id,
              status: verified ? "updated" : "failed",
              message: verified
                ? undefined
                : "Update completion was not verified. Inspect installed state and doctor before retrying."
            });
          } catch {
            op.results.push({
              id: target.id,
              status: "failed",
              message:
                "The target did not complete cleanly. Inspect its installed state before retrying."
            });
          }
        }
        const failed = op.results.some((result) => ["failed", "blocked"].includes(result.status));
        const action = op.results.some((result) => result.status === "requires-user-action");
        op.state = failed
          ? op.results.some((result) => result.status === "updated")
            ? "partial"
            : "failed"
          : action
            ? "requires-user-action"
            : "succeeded";
        op.exitCode = failed ? cliExit.failed : action ? cliExit.action : cliExit.success;
      }
    } catch {
      op.state = op.results.some((result) => result.status === "updated") ? "partial" : "failed";
      op.exitCode = cliExit.failed;
      op.message =
        "The operation did not finish cleanly. Inspect installed state and doctor before retrying.";
    } finally {
      op.finishedAt = new Date(this.now()).toISOString();
      this.active = undefined;
    }
  }
}
