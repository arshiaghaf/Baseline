// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type {
  ReleaseNotesRequest,
  ReleaseNotesResult,
  ReleaseNotesTarget
} from "../shared/releaseNotes";

type NotesReader = {
  getNotes(
    target: ReleaseNotesTarget,
    options: { signal: AbortSignal; force?: boolean }
  ): Promise<ReleaseNotesResult>;
};

/** Cancellation is scoped to the authenticated renderer, not globally guessable request IDs. */
export class ReleaseNotesRequests {
  private readonly owners = new Map<number, Map<string, AbortController>>();

  constructor(private readonly reader: NotesReader) {}

  async get(owner: number, request: ReleaseNotesRequest): Promise<ReleaseNotesResult> {
    const requests = this.owners.get(owner) ?? new Map<string, AbortController>();
    this.cancel(owner, request.requestID);
    if (requests.size >= 16) {
      return {
        status: "error",
        title: "Release notes",
        version: request.target.version,
        message: "Too many release-note requests. Close a preview and try again."
      };
    }
    this.owners.set(owner, requests);
    const controller = new AbortController();
    requests.set(request.requestID, controller);
    try {
      return await this.reader.getNotes(request.target, {
        signal: controller.signal,
        force: request.force
      });
    } finally {
      if (requests.get(request.requestID) === controller) requests.delete(request.requestID);
      if (!requests.size && this.owners.get(owner) === requests) this.owners.delete(owner);
    }
  }

  cancel(owner: number, requestID: string): void {
    const requests = this.owners.get(owner);
    requests?.get(requestID)?.abort();
    requests?.delete(requestID);
    if (!requests?.size) this.owners.delete(owner);
  }

  close(owner: number): void {
    for (const controller of this.owners.get(owner)?.values() ?? []) controller.abort();
    this.owners.delete(owner);
  }
}
