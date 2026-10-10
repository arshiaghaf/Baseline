// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import AppKit
import CoreGraphics
import Foundation

// Public window metadata only; no screen capture or additional permissions.
let windows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
) as? [[String: Any]] ?? []
let state: [String: Any] = [
    "frontmostPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
    "onScreenWindowIDs": windows.compactMap { $0[kCGWindowNumber as String] as? Int }
]
let data = try JSONSerialization.data(withJSONObject: state)
print(String(decoding: data, as: UTF8.self))
