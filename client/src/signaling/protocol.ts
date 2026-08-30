/**
 * Mirrors server/src/protocol.ts. Kept as a small duplicated file rather
 * than a shared package — the schema is tiny and unlikely to drift.
 */

export type ClientToServer =
  | { type: "register"; token: string; publicKey: string }
  | { type: "signal"; to: string; payload: unknown };

export type ServerToClient =
  | { type: "registered"; publicKey: string }
  | { type: "signal"; from: string; payload: unknown }
  | { type: "peer-offline"; publicKey: string }
  | { type: "error"; message: string };

export function parseServerMessage(raw: string): ServerToClient | null {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") return null;
    return msg as ServerToClient;
  } catch {
    return null;
  }
}
