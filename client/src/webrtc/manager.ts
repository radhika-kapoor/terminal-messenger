import { RTCPeerConnection, RTCIceCandidate, type RTCDataChannel } from "werift";
import naclUtil from "tweetnacl-util";
const { decodeBase64 } = naclUtil;
import { SignalingClient } from "../signaling/client.js";
import { encryptMessage, decryptMessage, type EncryptedPayload } from "../crypto/box.js";
import { ICE_SERVERS, RELAY_URL } from "../config.js";
import type { ConnectionState, SignalPayload } from "./types.js";

const OFFER_RETRY_MS = 1500;

interface PeerEntry {
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  state: ConnectionState;
}

export interface WebRTCManagerCallbacks {
  onMessage: (fromPublicKey: string, plaintext: string) => void;
  onStateChange: (peerPublicKey: string, state: ConnectionState) => void;
  onSignalingError?: (message: string) => void;
}

/**
 * Owns the single signaling-relay connection for this account and one
 * RTCPeerConnection per contact. Once a peer's DataChannel is open, all
 * messages flow directly between machines — the relay is no longer
 * involved.
 *
 * Only the side with the lexicographically smaller public key sends the
 * offer; the other waits and answers. That avoids glare when both run
 * `chat` at once.
 */
export class WebRTCManager {
  private readonly signaling: SignalingClient;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly wanted = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private destroyed = false;

  constructor(
    token: string,
    private readonly ownPublicKey: string,
    private readonly ownSecretKey: Uint8Array,
    private readonly callbacks: WebRTCManagerCallbacks,
  ) {
    this.signaling = new SignalingClient(RELAY_URL, token, ownPublicKey, {
      onSignal: (from, payload) => {
        this.handleSignal(from, payload as SignalPayload).catch((err) =>
          this.callbacks.onSignalingError?.(
            err instanceof Error ? err.message : String(err),
          ),
        );
      },
      onPeerOffline: (publicKey) => this.handlePeerOffline(publicKey),
      onError: (message) => {
        if (!this.destroyed) this.callbacks.onSignalingError?.(message);
      },
      onClose: () => {
        if (!this.destroyed) this.callbacks.onSignalingError?.("signaling disconnected");
      },
    });
    this.signaling.connect();
  }

  getState(remotePublicKey: string): ConnectionState {
    return this.peers.get(remotePublicKey)?.state ?? "idle";
  }

  async connectToPeer(remotePublicKey: string): Promise<void> {
    await this.signaling.waitUntilReady();
    this.wanted.add(remotePublicKey);

    const existing = this.peers.get(remotePublicKey);
    if (existing && existing.state !== "closed" && existing.state !== "peer-offline" && existing.state !== "failed") {
      return;
    }

    if (!this.isOfferer(remotePublicKey)) {
      this.setState(remotePublicKey, "connecting");
      return;
    }

    await this.startOffer(remotePublicKey);
  }

  sendMessage(remotePublicKey: string, plaintext: string): boolean {
    const entry = this.peers.get(remotePublicKey);
    if (!entry || entry.state !== "connected" || !entry.dataChannel) return false;
    const payload = encryptMessage(plaintext, this.ownSecretKey, decodeBase64(remotePublicKey));
    entry.dataChannel.send(JSON.stringify(payload));
    return true;
  }

  disconnectFromPeer(remotePublicKey: string): void {
    this.wanted.delete(remotePublicKey);
    this.clearRetry(remotePublicKey);
    this.closePeer(remotePublicKey);
    this.setState(remotePublicKey, "closed");
  }

  destroy(): void {
    this.destroyed = true;
    for (const key of Array.from(this.wanted)) this.wanted.delete(key);
    for (const key of Array.from(this.retryTimers.keys())) this.clearRetry(key);
    for (const key of Array.from(this.peers.keys())) this.disconnectFromPeer(key);
    this.signaling.disconnect();
  }

  /** Designated offerer is the lexicographically smaller public key. */
  private isOfferer(remotePublicKey: string): boolean {
    return this.ownPublicKey < remotePublicKey;
  }

  private async startOffer(remotePublicKey: string): Promise<void> {
    await this.signaling.waitUntilReady();
    if (!this.wanted.has(remotePublicKey) || !this.isOfferer(remotePublicKey)) return;
    if (this.peers.get(remotePublicKey)?.state === "connected") return;

    this.closePeer(remotePublicKey);

    const pc = this.createPeerConnection(remotePublicKey);
    const entry: PeerEntry = { pc, dataChannel: null, state: "connecting" };
    this.peers.set(remotePublicKey, entry);
    this.setState(remotePublicKey, "connecting");

    const dataChannel = pc.createDataChannel("chat");
    entry.dataChannel = dataChannel;
    this.wireDataChannel(remotePublicKey, dataChannel);

    const offer = await pc.createOffer();
    if (this.peers.get(remotePublicKey)?.pc !== pc) return;
    await pc.setLocalDescription(offer);
    this.signaling.sendSignal(remotePublicKey, { kind: "offer", sdp: offer.sdp } as SignalPayload);
  }

  private createPeerConnection(remotePublicKey: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return; // no candidate marks end-of-gathering
      if (this.peers.get(remotePublicKey)?.pc !== pc) return;
      this.signaling.sendSignal(remotePublicKey, {
        kind: "ice-candidate",
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid ?? null,
          sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
        },
      } as SignalPayload);
    };

    pc.onconnectionstatechange = () => {
      if (this.peers.get(remotePublicKey)?.pc !== pc) return;
      if (pc.connectionState === "failed") {
        this.setState(remotePublicKey, "failed");
        if (this.wanted.has(remotePublicKey) && this.isOfferer(remotePublicKey)) {
          this.scheduleOfferRetry(remotePublicKey);
        }
      }
      if (pc.connectionState === "closed") this.setState(remotePublicKey, "closed");
    };

    pc.ondatachannel = (event) => {
      if (this.peers.get(remotePublicKey)?.pc !== pc) return;
      const entry = this.peers.get(remotePublicKey);
      if (entry) entry.dataChannel = event.channel;
      this.wireDataChannel(remotePublicKey, event.channel);
    };

    return pc;
  }

  private wireDataChannel(remotePublicKey: string, channel: RTCDataChannel): void {
    channel.onopen = () => {
      this.clearRetry(remotePublicKey);
      this.setState(remotePublicKey, "connected");
    };
    channel.onclose = () => this.setState(remotePublicKey, "closed");

    channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const payload = JSON.parse(event.data) as EncryptedPayload;
        const plaintext = decryptMessage(payload, decodeBase64(remotePublicKey), this.ownSecretKey);
        if (plaintext !== null) this.callbacks.onMessage(remotePublicKey, plaintext);
      } catch {
        // Malformed or undecryptable payload — drop it, don't crash the channel.
      }
    };
  }

  private async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    if (payload.kind === "offer") {
      // Designated offerer ignores a colliding remote offer (impolite peer).
      if (this.isOfferer(from) && this.peers.get(from)?.pc.localDescription?.type === "offer") {
        return;
      }
      await this.acceptOffer(from, payload.sdp);
      return;
    }

    const entry = this.peers.get(from);
    if (!entry) return; // answer/ice-candidate with no known session in progress — ignore

    if (payload.kind === "answer") {
      await entry.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      return;
    }

    if (payload.kind === "ice-candidate") {
      await entry.pc.addIceCandidate(
        new RTCIceCandidate({
          candidate: payload.candidate.candidate,
          sdpMid: payload.candidate.sdpMid ?? undefined,
          sdpMLineIndex: payload.candidate.sdpMLineIndex ?? undefined,
        }),
      );
    }
  }

  private async acceptOffer(from: string, sdp: string): Promise<void> {
    this.clearRetry(from);
    this.closePeer(from);

    const pc = this.createPeerConnection(from);
    const entry: PeerEntry = { pc, dataChannel: null, state: "connecting" };
    this.peers.set(from, entry);
    this.setState(from, "connecting");

    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    if (this.peers.get(from)?.pc !== pc) return;
    await pc.setLocalDescription(answer);
    this.signaling.sendSignal(from, { kind: "answer", sdp: answer.sdp } as SignalPayload);
  }

  private handlePeerOffline(publicKey: string): void {
    if (this.peers.get(publicKey)?.state === "connected") return;
    this.closePeer(publicKey);
    this.setState(publicKey, "peer-offline");
    if (this.wanted.has(publicKey) && this.isOfferer(publicKey)) {
      this.scheduleOfferRetry(publicKey);
    }
  }

  private scheduleOfferRetry(publicKey: string): void {
    if (this.retryTimers.has(publicKey)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(publicKey);
      if (!this.wanted.has(publicKey)) return;
      if (this.peers.get(publicKey)?.state === "connected") return;
      this.startOffer(publicKey).catch((err) =>
        this.callbacks.onSignalingError?.(err instanceof Error ? err.message : String(err)),
      );
    }, OFFER_RETRY_MS);
    this.retryTimers.set(publicKey, timer);
  }

  private clearRetry(publicKey: string): void {
    const timer = this.retryTimers.get(publicKey);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(publicKey);
  }

  private closePeer(publicKey: string): void {
    const entry = this.peers.get(publicKey);
    if (!entry) return;
    entry.pc.close();
    this.peers.delete(publicKey);
  }

  private setState(peerPublicKey: string, state: ConnectionState): void {
    const entry = this.peers.get(peerPublicKey);
    if (entry) entry.state = state;
    this.callbacks.onStateChange(peerPublicKey, state);
  }
}
