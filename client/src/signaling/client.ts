import WebSocket from "ws";
import { parseServerMessage, type ClientToServer } from "./protocol.js";

export interface SignalingHandlers {
  onSignal: (from: string, payload: unknown) => void;
  onPeerOffline: (publicKey: string) => void;
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
 *
 * Outbound signals are queued until the relay has acknowledged `register`.
 * Callers must `await waitUntilReady()` before expecting a peer to be
 * reachable; `sendSignal` will still enqueue rather than drop if called early.
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private registered = false;
  private outbound: ClientToServer[] = [];
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readySettled = false;

  constructor(
    private readonly relayUrl: string,
    private readonly token: string,
    private readonly ownPublicKey: string,
    private readonly handlers: SignalingHandlers,
  ) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  connect(): void {
    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "register",
          token: this.token,
          publicKey: this.ownPublicKey,
        } satisfies ClientToServer),
      );
    });

    ws.on("message", (data) => {
      const msg = parseServerMessage(data.toString());
      if (!msg) return;
      if (msg.type === "registered") {
        this.markRegistered();
        return;
      }
      if (msg.type === "signal") this.handlers.onSignal(msg.from, msg.payload);
      if (msg.type === "peer-offline") this.handlers.onPeerOffline(msg.publicKey);
      if (msg.type === "error") this.handlers.onError?.(msg.message);
    });

    ws.on("error", (err) => {
      this.handlers.onError?.(err.message);
    });

    ws.on("close", () => {
      if (!this.registered) {
        this.settleReady(new Error("signaling disconnected before register"));
      }
      this.registered = false;
      this.handlers.onClose?.();
    });
  }

  sendSignal(to: string, payload: unknown): void {
    this.send({ type: "signal", to, payload });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  private markRegistered(): void {
    this.registered = true;
    this.flush();
    this.settleReady();
    this.handlers.onOpen?.();
  }

  private settleReady(err?: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    if (err) this.rejectReady(err);
    else this.resolveReady();
  }

  private send(message: ClientToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.registered) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    this.outbound.push(message);
  }

  private flush(): void {
    const queued = this.outbound;
    this.outbound = [];
    for (const msg of queued) this.send(msg);
  }
}
