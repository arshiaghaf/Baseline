// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { StringDecoder } from "node:string_decoder";
import { redactHomePaths } from "./redactHomePaths";

const rawLineLimit = 16 * 1024;
export const operationTailBytes = 8 * 1024;

/** Best effort for support output, not a guarantee that arbitrary logs contain no secrets. */
export function sanitizeOperationLine(line: string): string {
  return redactHomePaths(
    line
      .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/gi, "[REDACTED]")
      .replace(
        /HOMEBREW_(?:GITHUB|ARTIFACTORY|DOCKER)_API_TOKEN\s*=\s*.*/gi,
        "HOMEBREW_API_TOKEN=[REDACTED]"
      )
      .replace(/Authorization\s*:\s*.*/gi, "Authorization: [REDACTED]")
      .replace(/\bBearer\s*\S+/gi, "Bearer [REDACTED]")
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (url) =>
        url.includes("@") ? "[REDACTED URL]" : url
      )
  );
}

/** Per-pipe decoding and terminal state; never emit a partial or overlong raw line.
 * Complete lines are sanitized BEFORE retention caps. Existing raw command capture
 * and outputLine IPC are separate consumers and are not sanitized by this class. */
export class OperationOutputTail {
  private lines: string[] = [];
  private readonly streams = new Map<string, ReturnType<OperationOutputTail["makeStream"]>>();

  write(pipe: "stdout" | "stderr", chunk: Buffer): void {
    let stream = this.streams.get(pipe);
    if (!stream) {
      stream = this.makeStream();
      this.streams.set(pipe, stream);
    }
    stream.write(chunk);
  }
  end(pipe: "stdout" | "stderr"): void {
    this.streams.get(pipe)?.end();
  }
  text(): string | undefined {
    return this.lines.join("\n") || undefined;
  }

  private retain(raw: string): void {
    const line = sanitizeOperationLine(raw).trim();
    if (!line) return;
    this.lines.push(
      Buffer.byteLength(line) > operationTailBytes ? "[Long output line omitted]" : line
    );
    while (this.lines.length > 20 || Buffer.byteLength(this.lines.join("\n")) > operationTailBytes)
      this.lines.shift();
  }
  private makeStream() {
    const decoder = new StringDecoder("utf8");
    let line = "";
    let bytes = 0;
    let discarded = false;
    let state:
      | "text"
      | "escape"
      | "escapeIntermediate"
      | "csi"
      | "osc"
      | "oscEscape"
      | "string"
      | "stringEscape" = "text";
    const flush = () => {
      if (!discarded) this.retain(line);
      line = "";
      bytes = 0;
      discarded = false;
    };
    const consume = (text: string) => {
      for (const char of text) {
        const code = char.codePointAt(0)!;
        if (state === "osc" || state === "string") {
          if (char === "\x1b") state = state === "osc" ? "oscEscape" : "stringEscape";
          else if (code === 0x9c || (state === "osc" && char === "\x07")) state = "text";
          continue;
        }
        if (state === "oscEscape" || state === "stringEscape") {
          if (char === "\\") state = "text";
          else if (char !== "\x1b") state = state === "oscEscape" ? "osc" : "string";
          continue;
        }
        if (state === "csi") {
          if (code >= 0x40 && code <= 0x7e) state = "text";
          continue;
        }
        if (state === "escapeIntermediate") {
          if (code >= 0x30 && code <= 0x7e) state = "text";
          else if (code < 0x20 || code > 0x2f) discarded = true;
          continue;
        }
        if (state === "escape") {
          state =
            char === "["
              ? "csi"
              : char === "]"
                ? "osc"
                : /[PX^_]/.test(char)
                  ? "string"
                  : code >= 0x20 && code <= 0x2f
                    ? "escapeIntermediate"
                    : "text";
          continue;
        }
        if (char === "\x1b") {
          state = "escape";
          continue;
        }
        if (code === 0x9b) {
          state = "csi";
          continue;
        }
        if (code === 0x9d) {
          state = "osc";
          continue;
        }
        if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) {
          state = "string";
          continue;
        }
        if (char === "\n" || char === "\r") {
          flush();
          continue;
        }
        if (code < 32 || (code >= 127 && code <= 159) || /[\u202a-\u202e\u2066-\u2069]/.test(char))
          continue;
        if (discarded) continue;
        bytes += Buffer.byteLength(char);
        if (bytes > rawLineLimit) {
          line = "";
          discarded = true;
          continue;
        }
        line += char;
      }
    };
    return {
      write: (chunk: Buffer) => consume(decoder.write(chunk)),
      end: () => {
        consume(decoder.end());
        if (state === "text") flush();
        line = "";
      }
    };
  }
}
