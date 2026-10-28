// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { CLIError, cliExit, type CLIRequest, type CLIResponse } from "../shared/cli";
import { cliEndpoint, verifyCLIEndpointDirectory } from "./endpoint";

export async function sendCLIRequest(
  userData: string,
  request: CLIRequest,
  options: { timeoutMS?: number; signal?: AbortSignal } = {}
): Promise<CLIResponse> {
  const endpoint = cliEndpoint(userData);
  await verifyCLIEndpointDirectory(endpoint.directory);
  const entry = await lstat(endpoint.socket);
  options.signal?.throwIfAborted();
  if (!entry.isSocket() || entry.uid !== process.getuid!() || (entry.mode & 0o077) !== 0)
    throw new CLIError(
      "unsafe-endpoint",
      "The CLI endpoint is not private and owned by this user.",
      cliExit.unavailable
    );
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socket);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const aborted = () => fail(options.signal?.reason);
    const dispose = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
    };
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        dispose();
        socket.destroy();
        reject(error);
      }
    };
    const timer = setTimeout(
      () =>
        fail(
          new CLIError(
            "transport-timeout",
            "Baseline did not respond. Submitted work may still be running; query its operation ID before retrying.",
            cliExit.timeout
          )
        ),
      options.timeoutMS ?? 10_000
    );
    options.signal?.addEventListener("abort", aborted, { once: true });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("error", fail);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16 * 1024 * 1024 + 1) {
        fail(new CLIError("invalid-response", "Baseline returned too much data."));
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as CLIResponse;
        if (
          response.schemaVersion !== 1 ||
          typeof response.sessionID !== "string" ||
          typeof response.ok !== "boolean" ||
          !Number.isInteger(response.exitCode)
        )
          throw new Error("Invalid response");
        settled = true;
        dispose();
        socket.destroy();
        resolve(response);
      } catch {
        fail(
          new CLIError(
            "invalid-response",
            "Baseline returned an incompatible response. Update and restart Baseline.",
            cliExit.unavailable
          )
        );
      }
    });
    socket.once("close", () => {
      if (!settled)
        fail(
          new CLIError(
            "disconnected",
            "Baseline disconnected. Query the operation ID before retrying submitted work.",
            cliExit.unavailable
          )
        );
    });
  });
}
