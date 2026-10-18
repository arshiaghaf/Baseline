// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import type { AppProviderCheck, AppStoreProviderIdentity } from "../shared/domain";
import { isAllowedFeedURL } from "../shared/security";

/** Old snapshots have no provider history. Invalid history cannot authorize routing. */
export function normalizeAppProviderChecks(input: unknown): Record<string, AppProviderCheck> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([id, raw]) => {
      if (!raw || typeof raw !== "object") return [];
      const value = raw as Partial<AppProviderCheck>;
      if (typeof value.fingerprint !== "string" || value.fingerprint.length > 8192) return [];
      let status =
        value.status === "checked" || value.status === "failed" || value.status === "unresolved"
          ? value.status
          : "failed";
      const storefront =
        typeof value.storefront === "string" && /^[a-z]{2}$/i.test(value.storefront)
          ? value.storefront.toLowerCase()
          : undefined;
      const identity = value.appStoreIdentity;
      const appStoreIdentity: AppStoreProviderIdentity | undefined =
        identity &&
        typeof identity.storefront === "string" &&
        identity.storefront.toLowerCase() === storefront &&
        Number.isSafeInteger(identity.productID) &&
        identity.productID > 0 &&
        (identity.platform === "mac" || identity.platform === "ios")
          ? {
              productID: identity.productID,
              platform: identity.platform,
              storefront: identity.storefront.toLowerCase()
            }
          : undefined;
      const sparkleFeedURL =
        typeof value.sparkleFeedURL === "string" && isAllowedFeedURL(value.sparkleFeedURL)
          ? value.sparkleFeedURL
          : undefined;
      const source =
        value.source === "appStore" || value.source === "sparkle" || value.source === "homebrew"
          ? value.source
          : undefined;
      const checkedAt = validDate(value.checkedAt);
      if (
        status === "checked" &&
        (!storefront ||
          !source ||
          !checkedAt ||
          (source === "appStore" && !appStoreIdentity) ||
          (source === "sparkle" && !sparkleFeedURL))
      )
        status = "failed";
      return [
        [
          id,
          {
            fingerprint: value.fingerprint,
            storefront,
            status,
            appStoreIdentity,
            sparkleFeedURL,
            source,
            checkedAt,
            discoveryCheckedAt: validDate(value.discoveryCheckedAt)
          } satisfies AppProviderCheck
        ]
      ];
    })
  );
}

function validDate(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
