// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

// Stop waiting for read-only APIs which cannot cancel their underlying IO.
// Always observe late rejection; callers must not put mutations in this wrapper.
export function cancellableRead<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const release = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      release();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        release();
        resolve(value);
      },
      (error: unknown) => {
        release();
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}

export function readSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(8000);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export function rethrowCancelledRead(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
}
