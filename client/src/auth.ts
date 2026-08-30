import { SERVER_URL } from "./config.js";

export class AuthError extends Error {}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AuthError(typeof data.error === "string" ? data.error : `request failed (${res.status})`);
  }
  return data;
}

export async function registerAccount(username: string, password: string, publicKey: string): Promise<string> {
  const data = await postJson("/register", { username, password, publicKey });
  return data.token as string;
}

export async function loginAccount(username: string, password: string, publicKey: string): Promise<string> {
  const data = await postJson("/login", { username, password, publicKey });
  return data.token as string;
}

/** Resolves a contact's current WebRTC public key via the server directory. */
export async function lookupPublicKey(token: string, username: string): Promise<string | null> {
  const res = await fetch(`${SERVER_URL}/users/${encodeURIComponent(username)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new AuthError(typeof data.error === "string" ? data.error : `request failed (${res.status})`);
  }
  const data = (await res.json()) as { publicKey: string };
  return data.publicKey;
}
