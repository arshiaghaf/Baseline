// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

declare module "*.css";

declare module "*.png" {
  const url: string;
  export default url;
}
