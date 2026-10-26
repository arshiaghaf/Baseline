// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

export const signedUpdateFeedURL =
  "https://github.com/arshiaghaf/Baseline/releases/latest/download/appcast.xml";

export type SignedSelfUpdateConfiguration = {
  enabled: true;
  publicKey: string;
  feedURL: typeof signedUpdateFeedURL;
};

/** Only a key embedded by the release build may establish publisher trust. */
export function signedSelfUpdateConfiguration(
  value: unknown
): SignedSelfUpdateConfiguration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.enabled !== true ||
    raw.feedURL !== signedUpdateFeedURL ||
    typeof raw.publicKey !== "string" ||
    !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(raw.publicKey) ||
    raw.publicKey === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  )
    return undefined;
  return { enabled: true, publicKey: raw.publicKey, feedURL: signedUpdateFeedURL };
}
