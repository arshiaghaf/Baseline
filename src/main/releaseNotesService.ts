// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createHash } from "node:crypto";
import type {
  AppRecord,
  BaselineSnapshot,
  HomebrewManagedItem,
  UpdateRecord
} from "../shared/domain";
import type {
  ReleaseNotesFormat,
  ReleaseNotesResult,
  ReleaseNotesTarget
} from "../shared/releaseNotes";
import { homebrewCommandToken } from "../shared/homebrewIdentity";
import {
  fetchReleaseNotes,
  publicNotesURL,
  type ReleaseNotesFetcher,
  type ReleaseNotesResponse
} from "./releaseNotesFetch";
import { releaseNotesText } from "./releaseNotesText";
import { exactSparkleReleaseNotes, type SparkleHost } from "./sparkleAppcastClient";

type Context = {
  title: string;
  update?: UpdateRecord;
  app?: AppRecord;
  item?: HomebrewManagedItem;
};
type Options = { signal?: AbortSignal; force?: boolean };
type Pending = {
  task: Promise<ReleaseNotesResult>;
  controller: AbortController;
  consumers: Set<symbol>;
};
const defaultUnavailable = "Release notes aren’t available for this version.";

/** Optional read-only notes never alter inventory, source precedence or update eligibility. */
export class ReleaseNotesService {
  private readonly fetch: ReleaseNotesFetcher;
  private readonly now: () => number;
  private readonly host?: SparkleHost;
  private readonly cache = new Map<
    string,
    { result: ReleaseNotesResult; expires: number; bytes: number }
  >();
  private readonly pending = new Map<string, Pending>();
  private readonly pausedUntil = new Map<string, number>();
  private cachedBytes = 0;

  constructor(
    private readonly options: {
      getSnapshot: () => BaselineSnapshot;
      fetch?: ReleaseNotesFetcher;
      now?: () => number;
      host?: SparkleHost;
    }
  ) {
    this.fetch = options.fetch ?? fetchReleaseNotes;
    this.now = options.now ?? (() => performance.now());
    this.host = options.host;
  }

  async getNotes(target: ReleaseNotesTarget, options: Options = {}): Promise<ReleaseNotesResult> {
    options.signal?.throwIfAborted();
    const context = this.context(target);
    const base = { title: context?.title ?? "Release notes", version: target.version };
    if (!context)
      return {
        ...base,
        status: "unavailable",
        retryable: true,
        message: "This update changed. Open release notes again."
      };
    const key = this.key(target, context);
    const cached = this.cache.get(key);
    if (!options.force && cached && cached.expires > this.now())
      return structuredClone(cached.result);
    let pending = this.pending.get(key);
    if (pending?.controller.signal.aborted) {
      this.pending.delete(key);
      pending = undefined;
    }
    if (!pending) {
      if (this.pending.size >= 6)
        return {
          ...base,
          status: "error",
          message: "Other release notes are still loading. Try again shortly."
        };
      const controller = new AbortController();
      const entry: Pending = {
        controller,
        consumers: new Set(),
        task: Promise.resolve({ ...base, status: "unavailable" })
      };
      entry.task = this.load(target, context, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) this.remember(key, result);
          return result;
        })
        .finally(() => {
          if (this.pending.get(key) === entry) this.pending.delete(key);
        });
      pending = entry;
      this.pending.set(key, pending);
    }
    const subscriber = Symbol();
    pending.consumers.add(subscriber);
    const current = pending;
    try {
      const result = await this.observe(current.task, options.signal);
      const fresh = this.context(target);
      if (!fresh || this.key(target, fresh) !== key)
        return {
          ...base,
          status: "unavailable",
          retryable: true,
          message: "This update changed. Open release notes again."
        };
      return structuredClone(result);
    } finally {
      current.consumers.delete(subscriber);
      if (!current.consumers.size && this.pending.get(key) === current) current.controller.abort();
    }
  }

  private context(target: ReleaseNotesTarget): Context | undefined {
    const snapshot = this.options.getSnapshot();
    if (target.kind === "app") {
      const app = snapshot.apps.find((entry) => entry.id === target.id);
      const update = snapshot.updates.find((entry) => entry.appID === target.id);
      if (
        !app ||
        !update ||
        update.remoteVersion.raw !== target.version ||
        (update.remoteBuildVersion?.raw ?? "") !== (target.buildVersion ?? "")
      )
        return undefined;
      const item =
        update.source === "homebrew"
          ? snapshot.homebrewItems.find(
              (entry) =>
                entry.kind === "cask" &&
                entry.appID === app.id &&
                entry.token === update.homebrewToken
            )
          : undefined;
      return { title: app.displayName, app, update, item };
    }
    const item = snapshot.homebrewItems.find((entry) => entry.id === target.id);
    if (
      !item ||
      !item.isOutdated ||
      item.latestVersion?.raw !== target.version ||
      target.buildVersion
    )
      return undefined;
    const app =
      item.kind === "cask" && item.appID
        ? snapshot.apps.find((entry) => entry.id === item.appID)
        : undefined;
    return { title: item.name, item, app };
  }

  private key(target: ReleaseNotesTarget, context: Context): string {
    const { title, update, app, item } = context;
    return createHash("sha256")
      .update(
        JSON.stringify({
          target,
          title,
          update,
          app: app && {
            id: app.id,
            bundlePath: app.bundlePath,
            bundleIdentifier: app.bundleIdentifier,
            localVersion: app.localVersion,
            bundleVersion: app.bundleVersion,
            sparkleFeedURL: app.sparkleFeedURL,
            providerFingerprint: app.providerFingerprint
          },
          item: item && {
            id: item.id,
            token: item.token,
            fullToken: item.fullToken,
            tap: item.tap,
            latestVersion: item.latestVersion,
            formulaIdentity: item.formulaIdentity,
            formulaIdentityVerified: item.formulaIdentityVerified,
            caskMetadata: item.caskMetadata
          }
        })
      )
      .digest("hex");
  }

  private async load(
    target: ReleaseNotesTarget,
    context: Context,
    signal: AbortSignal
  ): Promise<ReleaseNotesResult> {
    const base = { title: context.title, version: target.version };
    const unavailable = (
      websiteURL?: string,
      message = defaultUnavailable
    ): ReleaseNotesResult => ({ ...base, status: "unavailable", websiteURL, message });
    try {
      const { update, app, item } = context;
      if (update?.source === "appStore") {
        const sourceURL = this.safeURL(update.updateURL);
        return update.releaseNotesSummary?.trim()
          ? this.content(base, "App Store", update.releaseNotesSummary, "plain-text", sourceURL)
          : unavailable(sourceURL);
      }
      if (update?.source === "sparkle") {
        if (update.releaseNotesContent?.trim())
          return this.content(
            base,
            "Sparkle",
            update.releaseNotesContent,
            update.releaseNotesFormat ?? "html",
            this.safeURL(update.releaseNotesURL)
          );
        if (update.releaseNotesURL) return await this.remote(base, update.releaseNotesURL, signal);
        if (app?.sparkleFeedURL)
          return (await this.feed(base, app.sparkleFeedURL, target, signal)) ?? unavailable();
        return unavailable();
      }
      if (!item) return unavailable();
      // A saved app ID alone is not proof that this package owns the publisher feed.
      const linked =
        app &&
        item.kind === "cask" &&
        homebrewCommandToken(item) &&
        item.caskMetadata?.installedAppPaths?.includes(app.bundlePath) &&
        (!app.bundleIdentifier ||
          item.caskMetadata.bundleIdentifiers.includes(app.bundleIdentifier));
      let feedError: unknown;
      if (linked && app.sparkleFeedURL) {
        try {
          const notes = await this.feed(base, app.sparkleFeedURL, target, signal);
          if (notes?.status === "available") return notes;
        } catch (error) {
          signal.throwIfAborted();
          feedError = error;
        }
      }
      const notes = await this.homebrew(base, item, signal);
      if (notes.status !== "available" && feedError) throw feedError;
      return notes;
    } catch (error) {
      signal.throwIfAborted();
      return {
        ...base,
        status: "error",
        message:
          error instanceof NotesRateLimit
            ? "The publisher is limiting requests. Try again later."
            : "Couldn’t load release notes. Try again."
      };
    }
  }

  private content(
    base: { title: string; version: string },
    source: ReleaseNotesResult["source"],
    text: string,
    format: ReleaseNotesFormat,
    sourceURL?: string
  ): ReleaseNotesResult {
    const { blocks, truncated } = releaseNotesText(text, format);
    return blocks.length
      ? {
          ...base,
          status: "available",
          source,
          sourceURL,
          blocks,
          message: truncated ? "Long release notes have been shortened." : undefined
        }
      : {
          ...base,
          status: "unavailable",
          source,
          sourceURL,
          websiteURL: sourceURL,
          message: defaultUnavailable
        };
  }

  private async remote(
    base: { title: string; version: string },
    raw: string,
    signal: AbortSignal
  ): Promise<ReleaseNotesResult> {
    const response = await this.read(raw, signal);
    if (response.status === 404 || response.status === 410)
      return {
        ...base,
        status: "unavailable",
        websiteURL: this.safeURL(raw),
        message: defaultUnavailable
      };
    this.requireSuccess(response);
    const type = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
    const format =
      type === "text/plain"
        ? "plain-text"
        : type === "text/markdown"
          ? "markdown"
          : type === "text/html" || type === "application/xhtml+xml"
            ? "html"
            : undefined;
    if (!format)
      return {
        ...base,
        status: "unavailable",
        websiteURL: this.safeURL(raw),
        message: "Open the publisher’s notes to read this format."
      };
    return this.content(base, "Sparkle", this.decode(response), format, this.safeURL(response.url));
  }

  private async feed(
    base: { title: string; version: string },
    url: string,
    target: ReleaseNotesTarget,
    signal: AbortSignal
  ): Promise<ReleaseNotesResult | undefined> {
    const response = await this.read(url, signal);
    this.requireSuccess(response);
    const notes = exactSparkleReleaseNotes(
      Buffer.from(this.decode(response)),
      target.version,
      target.buildVersion,
      this.host
    );
    if (notes?.content)
      return this.content(
        base,
        "Sparkle",
        notes.content,
        notes.format ?? "html",
        this.safeURL(notes.url)
      );
    if (notes?.url) return this.remote(base, notes.url, signal);
    return undefined;
  }

  private async homebrew(
    base: { title: string; version: string },
    item: HomebrewManagedItem,
    signal: AbortSignal
  ): Promise<ReleaseNotesResult> {
    const fallback = (
      websiteURL = this.safeURL(item.caskMetadata?.homepageURL)
    ): ReleaseNotesResult => ({
      ...base,
      status: "unavailable",
      websiteURL,
      message: "No version-matched publisher release notes were found."
    });
    const identity = homebrewCommandToken(item);
    const official =
      item.kind === "formula"
        ? item.formulaIdentity?.tap === "homebrew/core"
        : item.tap === "homebrew/cask";
    if (
      !identity ||
      !official ||
      !base.version.trim() ||
      /^latest$|^HEAD(?:-|$)/iu.test(base.version)
    )
      return fallback();
    const token = item.kind === "formula" ? item.formulaIdentity!.name : item.token;
    const response = await this.read(
      `https://formulae.brew.sh/api/${item.kind}/${encodeURIComponent(token)}.json`,
      signal
    );
    if (response.status === 404) return fallback();
    this.requireSuccess(response);
    const metadata = JSON.parse(this.decode(response));
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      (item.kind === "formula"
        ? metadata.name !== token || metadata.tap !== "homebrew/core"
        : metadata.token !== token || metadata.tap !== "homebrew/cask")
    )
      return fallback();
    const website = this.safeURL(metadata.homepage);
    const upstream = item.kind === "formula" ? metadata.versions?.stable : metadata.version;
    if (typeof upstream !== "string") return fallback(website);
    const revision =
      item.kind === "formula" && Number.isSafeInteger(metadata.revision) && metadata.revision > 0
        ? `_${metadata.revision}`
        : "";
    if ((item.kind === "formula" ? upstream + revision : upstream.split(",")[0]) !== base.version)
      return fallback(website);
    const mapping = githubReleaseFromMetadata(metadata, item.kind, upstream.split(",")[0]!);
    if (!mapping) return fallback(website);
    const { owner, repo, tag } = mapping;
    const release = await this.read(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      signal
    );
    if (release.status === 404) return fallback(website);
    this.requireSuccess(release);
    const data = JSON.parse(this.decode(release));
    if (
      data.tag_name !== tag ||
      data.draft === true ||
      (data.prerelease === true && !/alpha|beta|rc|pre|nightly|dev/iu.test(upstream)) ||
      typeof data.body !== "string" ||
      !data.body.trim()
    )
      return fallback(website);
    return this.content(
      base,
      "GitHub",
      data.body,
      "markdown",
      `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`
    );
  }

  private safeURL(value: unknown): string | undefined {
    return typeof value === "string" ? publicNotesURL(value)?.href : undefined;
  }

  private async read(url: string, signal: AbortSignal): Promise<ReleaseNotesResponse> {
    const safe = publicNotesURL(url);
    if (!safe) throw new Error("Unsafe release notes URL");
    if ((this.pausedUntil.get(safe.host) ?? 0) > this.now()) throw new NotesRateLimit();
    const response = await this.fetch(safe.href, { signal, maxBytes: 1024 * 1024 });
    if (response.data.byteLength > 1024 * 1024 || !publicNotesURL(response.url))
      throw new Error("Invalid release notes response");
    if (
      response.status === 429 ||
      (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0")
    ) {
      const seconds = Number(response.headers["retry-after"]);
      const retryDate = Date.parse(response.headers["retry-after"] ?? "") - Date.now();
      const reset = Number(response.headers["x-ratelimit-reset"]) * 1000 - Date.now();
      const delay =
        Number.isFinite(seconds) && seconds > 0
          ? seconds * 1000
          : Number.isFinite(retryDate) && retryDate > 0
            ? retryDate
            : Number.isFinite(reset) && reset > 0
              ? reset
              : 60_000;
      this.pausedUntil.set(safe.host, this.now() + Math.min(delay, 24 * 60 * 60 * 1000));
      if (this.pausedUntil.size > 128)
        this.pausedUntil.delete(this.pausedUntil.keys().next().value!);
      throw new NotesRateLimit();
    }
    return response;
  }

  private requireSuccess(response: ReleaseNotesResponse): void {
    if (response.status < 200 || response.status >= 300)
      throw new Error("Release notes unavailable");
  }

  private decode(response: ReleaseNotesResponse): string {
    const charset =
      /charset\s*=\s*["']?([a-z0-9_-]+)/iu.exec(response.headers["content-type"] ?? "")?.[1] ??
      "utf-8";
    return new TextDecoder(charset, { fatal: true }).decode(response.data);
  }

  private remember(key: string, result: ReleaseNotesResult): void {
    const previous = this.cache.get(key);
    if (previous) this.cachedBytes -= previous.bytes;
    const bytes = Buffer.byteLength(JSON.stringify(result));
    const ttl =
      result.status === "available"
        ? 10 * 60_000
        : result.status === "unavailable"
          ? 60_000
          : 10_000;
    this.cache.delete(key);
    this.cache.set(key, { result, expires: this.now() + ttl, bytes });
    this.cachedBytes += bytes;
    while (this.cache.size > 128 || this.cachedBytes > 4 * 1024 * 1024) {
      const oldest = this.cache.keys().next().value!;
      this.cachedBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
  }

  private observe<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}

class NotesRateLimit extends Error {}

/** A versioned source/download URL proves both the repository and the exact release tag. */
export function githubReleaseFromMetadata(
  metadata: any,
  kind: "formula" | "cask",
  version: string
): { owner: string; repo: string; tag: string } | undefined {
  const raw = kind === "formula" ? metadata.urls?.stable?.url : metadata.url;
  if (typeof raw !== "string") return undefined;
  const url = publicNotesURL(raw);
  if (url?.hostname !== "github.com") return undefined;
  const [owner, rawRepo, ...path] = url.pathname.split("/").filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/u, "");
  if (
    !owner ||
    !repo ||
    !/^[a-z0-9-]{1,39}$/iu.test(owner) ||
    !/^[a-z0-9_.-]{1,100}$/iu.test(repo) ||
    repo === "." ||
    repo === ".."
  )
    return undefined;
  let tag: string | undefined;
  if (path[0] === "releases" && path[1] === "download") tag = path[2];
  else if (path[0] === "archive")
    tag = (path[1] === "refs" && path[2] === "tags" ? path[3] : path[1])?.replace(
      /\.(?:tar\.gz|tar\.bz2|tar\.xz|tgz|zip)$/u,
      ""
    );
  else if (kind === "formula" && typeof metadata.urls?.stable?.tag === "string")
    tag = metadata.urls.stable.tag;
  if (!tag) return undefined;
  try {
    tag = decodeURIComponent(tag);
  } catch {
    return undefined;
  }
  if (tag !== version && tag !== `v${version}` && tag !== `V${version}`) return undefined;
  return { owner, repo, tag };
}
