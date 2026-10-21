// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { UpdateRecord } from "./domain";
import { sanitizeExternalURL } from "./security";

/** Resolve the existing external handoff without probing or downloading its target. */
export function externalAppUpdateAction(
  update: UpdateRecord
): { kind: "download" | "website"; url: string } | { kind: "app" } {
  const url = sanitizeExternalURL(update.updateURL);
  if (!url) return { kind: "app" };
  return {
    kind:
      update.source === "sparkle" && update.updateURLKind === "download" ? "download" : "website",
    url
  };
}
