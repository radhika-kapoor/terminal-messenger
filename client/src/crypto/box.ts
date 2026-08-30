import nacl from "tweetnacl";
// tweetnacl-util is a UMD module with no statically-analyzable named
// exports, so it must be imported as a default and destructured at
// runtime rather than via named ESM imports (which fail under Node's
// native ESM loader).
import naclUtil from "tweetnacl-util";
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclUtil;

export interface EncryptedPayload {
  nonce: string; // base64
  ciphertext: string; // base64
}

/**
 * Encrypts plaintext for a specific recipient using the sender's identity
 * keypair (NaCl box / X25519-XSalsa20-Poly1305). Only the holder of the
 * matching secret key can decrypt — true regardless of what relays the
 * ciphertext passes through.
 */
export function encryptMessage(
  plaintext: string,
  senderSecretKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): EncryptedPayload {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(decodeUTF8(plaintext), nonce, recipientPublicKey, senderSecretKey);
  return { nonce: encodeBase64(nonce), ciphertext: encodeBase64(ciphertext) };
}

/**
 * Decrypts a payload. Returns null if decryption/authentication fails —
 * e.g. the payload was tampered with or didn't actually come from the
 * claimed sender.
 */
export function decryptMessage(
  payload: EncryptedPayload,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): string | null {
  const opened = nacl.box.open(
    decodeBase64(payload.ciphertext),
    decodeBase64(payload.nonce),
    senderPublicKey,
    recipientSecretKey,
  );
  return opened ? encodeUTF8(opened) : null;
}
