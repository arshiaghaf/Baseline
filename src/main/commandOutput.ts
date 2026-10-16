// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { StringDecoder } from "node:string_decoder";

/** Byte-bounded capture. Tail trimming never starts in the middle of a UTF-8 codepoint. */
export class CommandCapture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  constructor(
    private readonly limit: number,
    private readonly tail: boolean
  ) {}

  append(text: string): void {
    if (!text || (this.truncated && !this.tail)) return;
    const chunk = Buffer.from(text, "utf8");
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (this.bytes <= this.limit) return;
    this.truncated = true;
    if (!this.tail) {
      this.chunks = [];
      this.bytes = 0;
      return;
    }
    while (this.bytes > this.limit && this.chunks.length) {
      const first = this.chunks[0]!;
      const excess = this.bytes - this.limit;
      if (excess >= first.length) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        let offset = excess;
        while (offset < first.length && (first[offset]! & 0xc0) === 0x80) offset++;
        this.chunks[0] = first.subarray(offset);
        this.bytes -= offset;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

/** Separate decoders for each pipe preserve split UTF-8 and CR-only progress.
 * Oversized progress lines are emitted in bounded segments; captured data is intact. */
export class CommandOutputStream {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  constructor(
    private readonly onText: (text: string) => void,
    private readonly onLine: (line: string) => void
  ) {}

  write(chunk: Buffer): void {
    this.append(this.decoder.write(chunk));
  }

  end(): void {
    this.append(this.decoder.end());
    this.emit(this.pending);
    this.pending = "";
  }

  private append(text: string): void {
    this.onText(text);
    this.pending += text;
    let delimiter: number;
    while ((delimiter = this.pending.search(/[\r\n]/)) !== -1) {
      this.emit(this.pending.slice(0, delimiter));
      this.pending = this.pending.slice(delimiter + 1);
    }
    while (this.pending.length > 16_384) {
      let end = 16_384;
      const code = this.pending.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
      this.emit(this.pending.slice(0, end));
      this.pending = this.pending.slice(end);
    }
  }

  private emit(text: string): void {
    while (text.length > 16_384) {
      let end = 16_384;
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
      const line = text.slice(0, end).trim();
      if (line) this.onLine(line);
      text = text.slice(end);
    }
    const line = text.trim();
    if (line) this.onLine(line);
  }
}
