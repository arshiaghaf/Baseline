// SPDX-FileCopyrightText: 2026 Arshia Ghaffarian
// SPDX-License-Identifier: GPL-3.0-only

import type { BaselineAPI } from "../shared/ipc";

declare global {
  interface Window {
    baseline: BaselineAPI;
  }
}

export {};
