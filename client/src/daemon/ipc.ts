import net from "node:net";
import fs from "node:fs";
import { encodeLine, LineDecoder, type CliToDaemon, type DaemonToCli } from "./protocol.js";

export interface DaemonServerHandlers {
  onMessage: (socket: net.Socket, message: CliToDaemon) => void;
  onDisconnect: (socket: net.Socket) => void;
}

/** Starts the daemon's local IPC listener. Removes any stale socket file first. */
export function createDaemonServer(socketPath: string, handlers: DaemonServerHandlers): net.Server {
  if (fs.existsSync(socketPath)) fs.rmSync(socketPath);

  const server = net.createServer((socket) => {
    const decoder = new LineDecoder<CliToDaemon>();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) handlers.onMessage(socket, message);
    });
    socket.on("close", () => handlers.onDisconnect(socket));
    socket.on("error", () => {
      /* the disconnect handler covers cleanup */
    });
  });

  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  return server;
}

export function sendToCli(socket: net.Socket, message: DaemonToCli): void {
  if (!socket.destroyed) socket.write(encodeLine(message));
}

/** Connects to a running daemon. Rejects if nothing is listening. */
export function connectToDaemon(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export function sendToDaemon(socket: net.Socket, message: CliToDaemon): void {
  socket.write(encodeLine(message));
}
