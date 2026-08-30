/**
 * WebSocket signaling protocol. The relay only ever forwards `payload`
 * opaquely by destination public key — it never inspects or stores SDP/ICE
 * contents. `register` additionally carries a JWT so only authenticated
 * accounts can publish a public key and receive signals.
 */

export type ClientToServer =
  | { type: "register"; token: string; publicKey: string }
  | { type: "signal"; to: string; payload: unknown };

export type ServerToClient =
  | { type: "registered"; publicKey: string }
  | { type: "signal"; from: string; payload: unknown }
  | { type: "peer-offline"; publicKey: string }
  | { type: "error"; message: string };

// A NaCl box public key is 32 raw bytes -> 44 base64 chars (with padding).
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{42,44}={0,2}$/;

export function isValidPublicKey(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY_RE.test(value);
}

export function parseClientMessage(raw: string): ClientToServer | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;

  if (m.type === "register" && typeof m.token === "string" && isValidPublicKey(m.publicKey)) {
    return { type: "register", token: m.token, publicKey: m.publicKey };
  }
  if (m.type === "signal" && isValidPublicKey(m.to) && "payload" in m) {
    return { type: "signal", to: m.to as string, payload: m.payload };
  }
  return null;
}
