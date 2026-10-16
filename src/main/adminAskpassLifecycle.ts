// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { AskpassMessage as Message, type AskpassFrame } from "./adminAskpassProtocol";

type PromptPhase =
  "hello" | "waiting" | "answered" | "cancelled" | "dialogError" | "complete" | "error";
type TerminationReason = "cancelled" | "error" | "command-exit";
type Prompt = { phase: PromptPhase; terminationReason?: TerminationReason };
export type AdminInvocationEvidence = {
  cancelled: boolean;
  helperError: boolean;
  cleanupConfirmed: boolean;
};

/** Status-only state machine. Deliberately dormant: it neither opens a socket nor
 * launches a helper. The command coordinator owns admission/ACK and teardown. */
export class AdminAskpassLifecycle {
  private readonly prompts = new Map<string, Prompt>();
  private waiting?: string;
  private cancellation = false;
  private error = false;
  private sealed = false;

  constructor(
    readonly operationID: string,
    private readonly changed: (waitingPromptID: string | undefined) => void
  ) {}

  get cancelled(): boolean {
    return this.cancellation;
  }
  get helperError(): boolean {
    return this.error;
  }
  get waitingPromptID(): string | undefined {
    return this.waiting;
  }

  receive(frame: AskpassFrame): "ack" | "defer" | "deny" {
    // A completed operation must never mutate the next operation's snapshot.
    if (this.sealed || frame.operationID !== this.operationID) return "deny";
    const prompt = this.prompts.get(frame.promptID);
    if (frame.type === Message.hello) {
      if (this.cancellation || this.error) return "deny";
      if (prompt) return prompt.phase === "hello" ? "ack" : this.invalid();
      this.prompts.set(frame.promptID, { phase: "hello" });
      return "ack";
    }
    if (!prompt) return this.invalid();
    if (frame.type === Message.invocationError) {
      prompt.phase = "error";
      this.error = true;
      this.clearWaiting(frame.promptID);
      return "ack";
    }
    if (frame.type === Message.begin) {
      if (this.cancellation || this.error) return "deny";
      if (prompt.phase === "waiting") return "ack";
      if (prompt.phase !== "hello") return this.invalid();
      if (this.waiting && this.waiting !== frame.promptID) return "defer";
      prompt.phase = "waiting";
      this.waiting = frame.promptID;
      this.changed(this.waiting);
      return "ack";
    }
    if (frame.type === Message.complete) {
      if (prompt.phase === "complete") return "ack";
      if (!["answered", "cancelled", "dialogError"].includes(prompt.phase)) return this.invalid();
      prompt.phase = "complete";
      this.clearWaiting(frame.promptID);
      return "ack";
    }
    const outcome: PromptPhase | undefined =
      frame.type === Message.answered
        ? "answered"
        : frame.type === Message.cancelled
          ? "cancelled"
          : frame.type === Message.dialogError
            ? "dialogError"
            : undefined;
    if (!outcome) return this.invalid();
    if (prompt.phase === outcome) return "ack";
    if (prompt.phase !== "waiting") return this.invalid();
    prompt.phase = outcome;
    if (outcome === "cancelled") this.cancellation = true;
    if (outcome === "dialogError") this.error = true;
    this.clearWaiting(frame.promptID);
    return "ack";
  }

  cancel(): void {
    if (!this.sealed) this.cancellation = true;
  }

  disconnected(promptID: string, terminationReason?: TerminationReason): void {
    if (this.sealed) return;
    const prompt = this.prompts.get(promptID);
    if (!prompt) {
      this.error = true;
      return;
    }
    prompt.terminationReason = terminationReason;
    if (terminationReason === "error") this.error = true;
    if (!this.expectedTermination(prompt) && !["complete", "error"].includes(prompt.phase))
      this.error = true;
    this.clearWaiting(promptID);
  }

  finish(cleanupConfirmed: boolean): AdminInvocationEvidence {
    for (const prompt of this.prompts.values()) {
      if (!this.expectedTermination(prompt) && !["complete", "error"].includes(prompt.phase))
        this.error = true;
    }
    this.sealed = true;
    if (this.waiting) {
      this.waiting = undefined;
      this.changed(undefined);
    }
    return { cancelled: this.cancellation, helperError: this.error, cleanupConfirmed };
  }

  private clearWaiting(promptID: string): void {
    if (this.waiting !== promptID) return;
    this.waiting = undefined;
    this.changed(undefined);
  }

  private expectedTermination(prompt: Prompt): boolean {
    return (
      (prompt.terminationReason === "cancelled" && this.cancellation) ||
      (prompt.terminationReason === "error" && this.error)
    );
  }

  private invalid(): "deny" {
    this.error = true;
    return "deny";
  }
}
