import type { BaselineAPI } from "../shared/ipc";

declare global {
  interface Window {
    baseline: BaselineAPI;
  }
}

export {};
