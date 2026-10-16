// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { IpcMainInvokeEvent, WebContents } from "electron";

export function isTrustedBackendSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  trustedContents: WebContents[],
  documentURL: string
): boolean {
  if (
    !trustedContents.includes(event.sender) ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  )
    return false;
  try {
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(documentURL);
    actual.hash = "";
    expected.hash = "";
    return actual.href === expected.href;
  } catch {
    return false;
  }
}
