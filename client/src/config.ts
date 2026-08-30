/**
 * Address of the terminal-messenger server (auth + WebRTC signaling only —
 * it never sees message content and stores nothing but accounts). Point
 * this at your Railway deployment via SERVER_URL, e.g.
 * https://your-app.up.railway.app
 */
export const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8787";

export const RELAY_URL = SERVER_URL.replace(/^http/, "ws") + "/relay";

/** STUN is used for NAT traversal during connection setup only. */
export const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
