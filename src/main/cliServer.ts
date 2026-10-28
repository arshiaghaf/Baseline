// SPDX-FileCopyrightText: 2026 Arshia Ghaf
// SPDX-License-Identifier: GPL-3.0-only

import { createServer, type Socket } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { cliEndpoint, verifyCLIEndpointDirectory } from "../cli/endpoint";
import { cliExit, type CLIResponse } from "../shared/cli";
import type { CLIService } from "./cliService";

export async function startCLIServer(
  userData: string,
  service: CLIService
): Promise<() => Promise<void>> {
  const endpoint = cliEndpoint(userData);
  await verifyCLIEndpointDirectory(endpoint.directory, true);
  // Only the holder of Electron's profile single-instance lock calls this.
  const old = await lstat(endpoint.socket).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (old) {
    if (!old.isSocket() || old.uid !== process.getuid!())
      throw new Error("Unexpected CLI endpoint; refusing to replace it.");
    await unlink(endpoint.socket);
  }
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    if (clients.size >= 32) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => clients.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let accepted = false;
    socket.on("data", (chunk: Buffer) => {
      if (accepted) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 64 * 1024) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      accepted = true;
      const respond = (response: CLIResponse) => {
        const json = JSON.stringify(response);
        socket.end(
          `${Buffer.byteLength(json) <= 16 * 1024 * 1024 ? json : JSON.stringify({ schemaVersion: 1, sessionID: service.sessionID, ok: false, exitCode: cliExit.failed, error: { code: "output-limit", message: "The result exceeded the CLI output limit." } })}\n`
        );
      };
      let request: unknown;
      try {
        if (newline !== buffer.length - 1) throw new Error("Multiple requests");
        request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        respond({
          schemaVersion: 1,
          sessionID: service.sessionID,
          ok: false,
          exitCode: cliExit.usage,
          error: {
            code: "invalid-json",
            message: "Expected one JSON request followed by a newline."
          }
        });
        return;
      }
      void service
        .handle(request)
        .then(respond)
        .catch(() => socket.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint.socket, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  await chmod(endpoint.socket, 0o600);
  // Runtime listener errors must not crash GUI state or produce uncaught events.
  server.on("error", () => undefined);
  return async () => {
    service.close();
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(endpoint.socket).catch(() => undefined);
  };
}
