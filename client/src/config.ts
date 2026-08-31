/**
 * Address of the terminal-messenger server (auth + WebRTC signaling only —
 * it never sees message content and stores nothing but accounts). Point
 * this at your Railway deployment via SERVER_URL, e.g.
 * https://your-app.up.railway.app
 */
export const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8787";

export const RELAY_URL = SERVER_URL.replace(/^http/, "ws") + "/relay";

/**
 * STUN is tried first for NAT traversal during connection setup. When
 * STUN-only hole-punching can't establish a direct path (symmetric NAT,
 * CGNAT, restrictive firewalls — common when the two peers are on very
 * different networks), WebRTC falls back to relaying encrypted traffic
 * through a TURN server instead of hanging indefinitely at "connecting".
 * A TURN relay never breaks end-to-end encryption or privacy — it only
 * ever sees already-encrypted DataChannel bytes, same as the signaling
 * relay never seeing plaintext.
 *
 * The TURN entries below are Open Relay Project's free public servers
 * (openrelay.metered.ca) — fine to unblock testing, but it's a shared
 * free tier with no uptime guarantee. For anything you depend on, replace
 * these with your own (self-hosted coturn, or a paid TURN provider).
 */
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];
