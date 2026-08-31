import WebSocket from "ws";
import { parseServerMessage, type ClientToServer } from "./protocol.js";

export interface SignalingHandlers {
  onSignal: (from: string, payload: unknown) => void;
  onPeerOffline: (publicKey: string) => void;
  onPeerOnline: (publicKey: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (message: string) => void;
}

/**
 * Thin WebSocket wrapper around the signaling relay. Registers this
 * account's public key (authenticated with its session token) on connect
 * and forwards opaque WebRTC offer/answer/ICE payloads. The relay never
 * sees message content — only this connection-setup metadata passes
 * through it.
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly watches = new Set<string>();

  constructor(
    private readonly relayUrl: string,
    private readonly token: string,
    private readonly ownPublicKey: string,
    private readonly handlers: SignalingHandlers,
  ) {}

  connect(): void {
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.send({ type: "register", token: this.token, publicKey: this.ownPublicKey });
      // Re-declare any outstanding watches on (re)connect — the relay's
      // watcher list is in-memory only and doesn't survive our disconnect.
      for (const publicKey of this.watches) this.send({ type: "watch", publicKey });
      this.handlers.onOpen?.();
    });

    ws.on("message", (data) => {
      const msg = parseServerMessage(data.toString());
      if (!msg) return;
      if (msg.type === "signal") this.handlers.onSignal(msg.from, msg.payload);
      if (msg.type === "peer-offline") this.handlers.onPeerOffline(msg.publicKey);
      if (msg.type === "peer-online") this.handlers.onPeerOnline(msg.publicKey);
      if (msg.type === "error") this.handlers.onError?.(msg.message);
    });

    ws.on("close", () => this.handlers.onClose?.());
  }

  sendSignal(to: string, payload: unknown): void {
    this.send({ type: "signal", to, payload });
  }

  /** Asks the relay to tell us when `publicKey` next comes online. */
  watchPeer(publicKey: string): void {
    this.watches.add(publicKey);
    this.send({ type: "watch", publicKey });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(message: ClientToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}
