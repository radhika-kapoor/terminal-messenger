import type { ConnectionState } from "../webrtc/types.js";

/**
 * Local IPC protocol between the thin CLI and the daemon, newline-delimited
 * JSON over a Unix domain socket at ~/.terminal-messenger/<user>/daemon.sock.
 * This never leaves the machine — it's not the network protocol.
 */

export type CliToDaemon =
  | { type: "send"; contact: string; text: string }
  | { type: "subscribe"; contact: string }
  | { type: "unsubscribe"; contact: string }
  | { type: "ping" };

export type DaemonToCli =
  | { type: "message"; contact: string; direction: "sent" | "received"; text: string; timestamp: string }
  | { type: "queued"; contact: string; text: string }
  | { type: "state"; contact: string; state: ConnectionState }
  | { type: "error"; contact?: string; message: string }
  | { type: "pong" };

export function encodeLine(message: CliToDaemon | DaemonToCli): string {
  return JSON.stringify(message) + "\n";
}

/** Splits a growing buffer of received bytes into complete JSON lines. */
export class LineDecoder<T> {
  private buffer = "";

  push(chunk: Buffer | string): T[] {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const messages: T[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        messages.push(JSON.parse(line) as T);
      } catch {
        // Malformed line — drop it, don't crash the connection.
      }
    }
    return messages;
  }
}
