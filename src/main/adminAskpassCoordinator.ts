// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { AdminAskpassLifecycle, type AdminInvocationEvidence } from "./adminAskpassLifecycle";
import {
  AskpassFrameReader,
  AskpassMessage as M,
  encodeAskpassFrame,
  type AskpassFrame
} from "./adminAskpassProtocol";

export type AdminCleanupReason = "cancelled" | "error" | "command-exit";
type Peer = {
  socket: Socket;
  reader: AskpassFrameReader;
  promptID?: string;
  registered?: boolean;
  deferred?: AskpassFrame;
  terminationReason?: AdminCleanupReason;
};
type CoordinatorOptions = {
  operationID: string;
  onWaitingChanged(promptID: string | undefined): void;
  onStopRequested(reason: "cancelled" | "error"): void;
};

/** Status transport only. It never launches a helper or receives its stdout.
 * Dormant until command-runner integration; no environment can activate it. */
export class AdminAskpassCoordinator {
  readonly lifecycle: AdminAskpassLifecycle;
  readonly socketPath: string;
  private readonly server: Server;
  private readonly peers = new Set<Peer>();
  private readonly claimed = new Set<string>();
  private changed?: () => void;
  private error = false;
  private stopped = false;
  private cleanupReason?: AdminCleanupReason;
  private stopNotified = false;
  private serverClosed?: Promise<void>;
  private prepared?: Promise<void>;
  private finished?: Promise<AdminInvocationEvidence>;

  private constructor(
    private readonly directory: string,
    private readonly options: CoordinatorOptions
  ) {
    this.socketPath = path.join(directory, "status");
    this.lifecycle = new AdminAskpassLifecycle(options.operationID, (promptID) => {
      try {
        options.onWaitingChanged(promptID);
      } catch {
        this.fail();
      }
    });
    this.server = createServer((socket) => this.accept(socket));
  }

  static async create(options: CoordinatorOptions): Promise<AdminAskpassCoordinator> {
    if (!/^[a-f0-9]{32}$/u.test(options.operationID) || /^0+$/u.test(options.operationID))
      throw new Error("Invalid administrator operation identity.");
    const directory = await mkdtemp("/tmp/baseline-admin-");
    let coordinator: AdminAskpassCoordinator | undefined;
    try {
      await chmod(directory, 0o700);
      coordinator = new AdminAskpassCoordinator(directory, options);
      const server = coordinator.server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(coordinator!.socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      server.on("error", () => coordinator!.fail());
      await chmod(coordinator.socketPath, 0o600);
      return coordinator;
    } catch {
      coordinator?.server.close();
      await rm(directory, { recursive: true, force: true });
      throw new Error("Could not start the administrator password helper status channel.");
    }
  }

  focus(operationID: string, promptID: string): boolean {
    if (
      this.stopped ||
      operationID !== this.options.operationID ||
      this.lifecycle.waitingPromptID !== promptID
    )
      return false;
    const peer = [...this.peers].find((candidate) => candidate.promptID === promptID);
    if (!peer) return false;
    this.write(peer, { operationID, promptID, type: M.focus });
    return true;
  }

  private accept(socket: Socket): void {
    if (this.stopped || this.lifecycle.cancelled || this.error) {
      socket.destroy();
      return;
    }
    // A resource bound on concurrent transports, unrelated to sudo retry policy.
    if (this.peers.size >= 16) {
      socket.destroy();
      this.fail();
      return;
    }
    const peer: Peer = { socket, reader: new AskpassFrameReader() };
    this.peers.add(peer);
    socket.on("data", (bytes: Buffer) => {
      try {
        for (const frame of peer.reader.write(bytes)) this.receive(peer, frame);
      } catch {
        this.fail();
        socket.destroy();
      }
    });
    socket.on("error", () => {
      if (!peer.terminationReason) this.fail();
    });
    socket.on("close", () => {
      try {
        peer.reader.end();
      } catch {
        this.fail();
      }
      if (peer.registered && peer.promptID)
        this.lifecycle.disconnected(peer.promptID, peer.terminationReason);
      else if (!this.lifecycle.cancelled) this.fail();
      this.peers.delete(peer);
      this.changed?.();
      if (this.lifecycle.helperError) this.fail();
    });
  }

  private receive(peer: Peer, frame: AskpassFrame): void {
    if (
      frame.operationID !== this.options.operationID ||
      frame.type < M.hello ||
      frame.type > M.invocationError
    )
      throw new Error("Invalid administrator helper lifecycle.");
    if (!peer.promptID) {
      if (frame.type !== M.hello || this.claimed.has(frame.promptID))
        throw new Error("Invalid administrator helper invocation.");
      // Bound retained invocation identities, never a count of password retries.
      if (this.claimed.size >= 4096) throw new Error("Administrator status capacity exceeded.");
      peer.promptID = frame.promptID;
      this.claimed.add(frame.promptID);
    } else if (peer.promptID !== frame.promptID)
      throw new Error("Administrator invocation changed.");
    const admission = frame.type === M.hello || frame.type === M.begin;
    let result = this.admissionBlocked() && admission ? "deny" : this.lifecycle.receive(frame);
    // Waiting publication can synchronously cancel or begin command cleanup.
    // Recheck every admission latch before acknowledging the native dialog.
    if (admission && this.admissionBlocked()) result = "deny";
    if (result === "defer") {
      peer.deferred = frame;
      return;
    }
    if (result === "deny") {
      peer.deferred = undefined;
      peer.terminationReason =
        this.cleanupReason ?? (this.lifecycle.cancelled ? "cancelled" : "error");
      this.write(peer, { ...frame, type: M.deny });
      peer.socket.end();
      if (!this.lifecycle.cancelled) this.fail();
      return;
    }
    if (frame.type === M.hello) peer.registered = true;
    if (frame.type !== M.hello) peer.deferred = undefined;
    this.write(peer, { ...frame, type: frame.type | 128 });
    if (this.lifecycle.cancelled) this.requestStop("cancelled");
    if (this.lifecycle.helperError) this.fail();
    // The native dialog has closed on an outcome, before answer delivery ends.
    // A previous COMPLETE must never clear the newly admitted prompt's wait.
    for (const candidate of this.peers) {
      if (candidate.deferred) this.receive(candidate, candidate.deferred);
      if (this.lifecycle.waitingPromptID) break;
    }
  }

  private admissionBlocked(): boolean {
    return this.stopped || this.error || this.lifecycle.cancelled || this.lifecycle.helperError;
  }

  private write(peer: Peer, frame: AskpassFrame): void {
    peer.socket.write(encodeAskpassFrame(frame), (error) => {
      if (error && peer.terminationReason !== "cancelled") this.fail();
    });
  }

  private fail(): void {
    this.error = true;
    this.requestStop("error");
  }

  private requestStop(reason: "cancelled" | "error"): void {
    if (this.stopNotified) return;
    this.stopNotified = true;
    try {
      this.options.onStopRequested(reason);
    } catch {
      this.error = true;
    }
  }

  /** Called only when command cleanup has already started. This deadline is the
   * existing cleanup budget, never a deadline on mutation/password interaction. */
  prepareCleanup(reason: AdminCleanupReason, deadline: number): Promise<void> {
    this.prepared ??= this.drain(reason, deadline);
    return this.prepared;
  }

  private async drain(reason: AdminCleanupReason, deadline: number): Promise<void> {
    this.stopped = true;
    this.cleanupReason = reason;
    if (reason === "cancelled") this.lifecycle.cancel();
    if (reason === "error") this.error = true;
    this.serverClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const peer of this.peers) {
      if (peer.deferred) {
        const deferred = peer.deferred;
        peer.deferred = undefined;
        peer.terminationReason = reason;
        this.write(peer, { ...deferred, type: M.deny });
        peer.socket.end();
      }
    }
    if (this.peers.size && performance.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve) => {
          this.changed = () => {
            if (!this.peers.size) resolve();
          };
          timer = setTimeout(resolve, Math.max(1, deadline - performance.now()));
          this.changed();
        });
      } finally {
        clearTimeout(timer);
        this.changed = undefined;
      }
    }
    const closed: Promise<void>[] = [];
    for (const peer of this.peers) {
      closed.push(new Promise<void>((resolve) => peer.socket.once("close", () => resolve())));
      peer.terminationReason = reason;
      peer.socket.destroy();
    }
    // Socket close owns disconnected evidence. Await it explicitly rather than
    // depending on the server-close callback's ordering relative to each peer.
    await Promise.all(closed);
    await this.serverClosed;
  }

  /** Finish only after command/group cleanup, with independent absence evidence. */
  finish(cleanupConfirmed: boolean): Promise<AdminInvocationEvidence> {
    this.finished ??= (async () => {
      await this.prepareCleanup("command-exit", performance.now());
      let removed = true;
      try {
        await rm(this.directory, { recursive: true, force: true });
      } catch {
        removed = false;
      }
      const evidence = this.lifecycle.finish(cleanupConfirmed && removed);
      return { ...evidence, helperError: evidence.helperError || this.error };
    })();
    return this.finished;
  }
}
