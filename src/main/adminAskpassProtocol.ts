// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

/** Status only. Keep in sync with native/admin-askpass/protocol.h. No text payload exists. */
export const askpassFrameBytes = 40;
export const AskpassMessage = {
  hello: 1,
  begin: 2,
  answered: 3,
  cancelled: 4,
  dialogError: 5,
  complete: 6,
  invocationError: 7,
  focus: 64,
  deny: 65
} as const;
export type AskpassFrame = { type: number; operationID: string; promptID: string };
const messages = new Set<number>(Object.values(AskpassMessage));
const validID = (value: string) => /^[a-f0-9]{32}$/u.test(value) && !/^0+$/u.test(value);
const validType = (type: number) =>
  Number.isInteger(type) && (messages.has(type) || (type >= 129 && type <= 135));

export function encodeAskpassFrame(frame: AskpassFrame): Buffer {
  if (!validType(frame.type) || !validID(frame.operationID) || !validID(frame.promptID))
    throw new Error("Invalid admin helper status frame.");
  const bytes = Buffer.alloc(askpassFrameBytes);
  bytes.write("BAP1", 0, "ascii");
  bytes[4] = 1;
  bytes[5] = frame.type;
  Buffer.from(frame.operationID, "hex").copy(bytes, 8);
  Buffer.from(frame.promptID, "hex").copy(bytes, 24);
  return bytes;
}

export class AskpassFrameReader {
  private pending = Buffer.alloc(0);

  write(chunk: Buffer): AskpassFrame[] {
    // Bound each transport callback as well as the retained partial frame.
    if (chunk.length > 4096) throw new Error("Admin helper status overflow.");
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: AskpassFrame[] = [];
    while (this.pending.length >= askpassFrameBytes) {
      const bytes = this.pending.subarray(0, askpassFrameBytes);
      this.pending = this.pending.subarray(askpassFrameBytes);
      const frame = {
        type: bytes[5]!,
        operationID: bytes.subarray(8, 24).toString("hex"),
        promptID: bytes.subarray(24, 40).toString("hex")
      };
      if (
        !bytes.subarray(0, 4).equals(Buffer.from("BAP1", "ascii")) ||
        bytes[4] !== 1 ||
        bytes[6] !== 0 ||
        bytes[7] !== 0 ||
        !validType(frame.type) ||
        !validID(frame.operationID) ||
        !validID(frame.promptID)
      )
        throw new Error("Invalid admin helper status frame.");
      frames.push(frame);
    }
    return frames;
  }

  end(): void {
    if (this.pending.length) throw new Error("Incomplete admin helper status frame.");
  }
}
