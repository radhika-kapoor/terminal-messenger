import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { accountDir } from "../storage/paths.js";

const { encodeBase64, decodeBase64 } = naclUtil;

export interface Identity {
  publicKey: string; // base64, this is what the server hands out to contacts
  secretKey: Uint8Array;
}

function identityPath(username: string): string {
  return path.join(accountDir(username), "identity.json");
}

/**
 * Loads this account's persisted X25519 keypair, or generates and persists
 * a new one on first use. The secret key never leaves this file (mode
 * 0600) and is never sent to the server — only the public key is.
 */
export function getOrCreateIdentity(username: string): Identity {
  const file = identityPath(username);

  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { secretKey: string };
    const secretKey = decodeBase64(stored.secretKey);
    const publicKey = encodeBase64(nacl.box.keyPair.fromSecretKey(secretKey).publicKey);
    return { publicKey, secretKey };
  }

  const keyPair = nacl.box.keyPair();
  fs.writeFileSync(file, JSON.stringify({ secretKey: encodeBase64(keyPair.secretKey) }), {
    mode: 0o600,
  });

  return { publicKey: encodeBase64(keyPair.publicKey), secretKey: keyPair.secretKey };
}
