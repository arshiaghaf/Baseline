// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only
import { expect, it } from "vitest";
import { AskpassFrameReader, encodeAskpassFrame } from "../src/main/adminAskpassProtocol";

const frame = { type: 3, operationID: "1".repeat(32), promptID: "2".repeat(32) };
it("decodes split and coalesced status frames with no variable payload", () => {
  const reader = new AskpassFrameReader();
  const bytes = encodeAskpassFrame(frame);
  expect(bytes).toHaveLength(40);
  expect(reader.write(bytes.subarray(0, 17))).toEqual([]);
  expect(reader.write(Buffer.concat([bytes.subarray(17), bytes]))).toEqual([frame, frame]);
  expect(() => reader.end()).not.toThrow();
});

it.each([0, 4, 5, 6, 7, 8, 24])("rejects invalid frame field at byte %s", (offset) => {
  const bytes = encodeAskpassFrame(frame);
  if (offset === 8 || offset === 24) bytes.fill(0, offset, offset + 16);
  else bytes[offset] = 255;
  expect(() => new AskpassFrameReader().write(bytes)).toThrow("Invalid admin helper");
});

it("rejects oversized and incomplete transport without including bytes in errors", () => {
  expect(() => new AskpassFrameReader().write(Buffer.alloc(4097))).toThrow("status overflow");
  const reader = new AskpassFrameReader();
  reader.write(encodeAskpassFrame(frame).subarray(0, 39));
  expect(() => reader.end()).toThrow("Incomplete admin helper status frame.");
});

it("rejects high-bit magic and fractional message types without normalizing them", () => {
  const bytes = encodeAskpassFrame(frame);
  for (let i = 0; i < 4; i++) bytes[i] = bytes[i]! | 128;
  expect(() => new AskpassFrameReader().write(bytes)).toThrow("Invalid admin helper status frame.");
  expect(() => encodeAskpassFrame({ ...frame, type: 129.5 })).toThrow(
    "Invalid admin helper status frame."
  );
});
