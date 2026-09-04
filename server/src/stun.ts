import dgram from "node:dgram";

/**
 * A minimal RFC 5389 STUN Binding-Request/Binding-Success-Response
 * responder over UDP. This exists so our own server — not just Google's or
 * Open Relay's public STUN servers — can tell a client its public
 * IP:port, reducing dependence on third parties for that one lookup.
 *
 * What this is NOT:
 * - Not a TURN server. It never relays media/data, only echoes back the
 *   address a UDP packet arrived from — out of scope per this project's
 *   NAT-traversal design (see client/src/config.ts).
 * - No authentication, no MESSAGE-INTEGRITY/FINGERPRINT attributes, no
 *   long-term credentials — matches how public binding-only STUN servers
 *   (e.g. stun.l.google.com) behave for anonymous Binding requests.
 * - IPv4 only.
 */

const MAGIC_COOKIE = 0x2112a442;
const MAGIC_COOKIE_BYTES = [0x21, 0x12, 0xa4, 0x42];
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS_RESPONSE = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;
const HEADER_LENGTH = 20;

export function startStunServer(port: number): void {
  const socket = dgram.createSocket("udp4");

  socket.on("message", (msg, rinfo) => {
    try {
      if (msg.length < HEADER_LENGTH) return;
      if (msg.readUInt16BE(0) !== BINDING_REQUEST) return;
      if (msg.readUInt32BE(4) !== MAGIC_COOKIE) return;

      const transactionId = msg.subarray(8, 20);
      const response = Buffer.alloc(32);

      response.writeUInt16BE(BINDING_SUCCESS_RESPONSE, 0);
      response.writeUInt16BE(0x0008, 2); // attribute length: 8-byte XOR-MAPPED-ADDRESS value
      response.writeUInt32BE(MAGIC_COOKIE, 4);
      transactionId.copy(response, 8);

      response.writeUInt16BE(XOR_MAPPED_ADDRESS, 20);
      response.writeUInt16BE(0x0008, 22);
      response.writeUInt8(0x00, 24); // reserved
      response.writeUInt8(0x01, 25); // family: IPv4
      response.writeUInt16BE(rinfo.port ^ (MAGIC_COOKIE >>> 16), 26);

      const addressOctets = rinfo.address.split(".").map(Number);
      for (let i = 0; i < 4; i++) {
        response.writeUInt8(addressOctets[i] ^ MAGIC_COOKIE_BYTES[i], 28 + i);
      }

      socket.send(response, rinfo.port, rinfo.address);
    } catch {
      // Malformed or unparseable datagram — drop it, don't crash the responder.
    }
  });

  socket.on("error", (err) => console.error("[stun] socket error", err));
  socket.on("listening", () => console.log(`[stun] binding responder listening on udp://0.0.0.0:${port}`));
  socket.bind(port);
}
