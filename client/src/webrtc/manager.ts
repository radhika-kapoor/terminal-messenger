import { RTCPeerConnection, RTCIceCandidate, type RTCDataChannel } from "werift";
import naclUtil from "tweetnacl-util";
const { decodeBase64 } = naclUtil;
import { SignalingClient } from "../signaling/client.js";
import { encryptMessage, decryptMessage, type EncryptedPayload } from "../crypto/box.js";
import { ICE_SERVERS, RELAY_URL } from "../config.js";
import type { ConnectionState, SignalPayload } from "./types.js";

interface PeerEntry {
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  state: ConnectionState;
}

export interface WebRTCManagerCallbacks {
  onMessage: (fromPublicKey: string, plaintext: string) => void;
  onStateChange: (peerPublicKey: string, state: ConnectionState) => void;
  onPeerOnline: (peerPublicKey: string) => void;
}

/**
 * Owns the single signaling-relay connection for this account and one
 * RTCPeerConnection per contact. Once a peer's DataChannel is open, all
 * messages flow directly between machines — the relay is no longer
 * involved.
 */
export class WebRTCManager {
  private readonly signaling: SignalingClient;
  private readonly peers = new Map<string, PeerEntry>();

  constructor(
    token: string,
    ownPublicKey: string,
    private readonly ownSecretKey: Uint8Array,
    private readonly callbacks: WebRTCManagerCallbacks,
  ) {
    this.signaling = new SignalingClient(RELAY_URL, token, ownPublicKey, {
      onSignal: (from, payload) => {
        this.handleSignal(from, payload as SignalPayload).catch((err) =>
          console.warn("[webrtc] failed to handle signal", err),
        );
      },
      onPeerOffline: (publicKey) => this.setState(publicKey, "peer-offline"),
      onPeerOnline: (publicKey) => this.callbacks.onPeerOnline(publicKey),
    });
    this.signaling.connect();
  }

  getState(remotePublicKey: string): ConnectionState {
    return this.peers.get(remotePublicKey)?.state ?? "idle";
  }

  /** Asks the relay to tell us when `remotePublicKey` next comes online. */
  watchPeer(remotePublicKey: string): void {
    this.signaling.watchPeer(remotePublicKey);
  }

  async connectToPeer(remotePublicKey: string): Promise<void> {
    const existing = this.peers.get(remotePublicKey);
    if (existing && existing.state !== "closed" && existing.state !== "peer-offline" && existing.state !== "failed") {
      return;
    }

    const pc = this.createPeerConnection(remotePublicKey);
    const entry: PeerEntry = { pc, dataChannel: null, state: "connecting" };
    this.peers.set(remotePublicKey, entry);
    this.setState(remotePublicKey, "connecting");

    const dataChannel = pc.createDataChannel("chat");
    entry.dataChannel = dataChannel;
    this.wireDataChannel(remotePublicKey, dataChannel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendSignal(remotePublicKey, { kind: "offer", sdp: offer.sdp } as SignalPayload);
  }

  sendMessage(remotePublicKey: string, plaintext: string): boolean {
    const entry = this.peers.get(remotePublicKey);
    if (!entry || entry.state !== "connected" || !entry.dataChannel) return false;
    const payload = encryptMessage(plaintext, this.ownSecretKey, decodeBase64(remotePublicKey));
    entry.dataChannel.send(JSON.stringify(payload));
    return true;
  }

  disconnectFromPeer(remotePublicKey: string): void {
    const entry = this.peers.get(remotePublicKey);
    entry?.pc.close();
    this.peers.delete(remotePublicKey);
    this.setState(remotePublicKey, "closed");
  }

  destroy(): void {
    for (const key of Array.from(this.peers.keys())) this.disconnectFromPeer(key);
    this.signaling.disconnect();
  }

  private createPeerConnection(remotePublicKey: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return; // no candidate marks end-of-gathering
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
      if (pc.connectionState === "failed") this.setState(remotePublicKey, "failed");
      if (pc.connectionState === "closed") this.setState(remotePublicKey, "closed");
    };

    pc.ondatachannel = (event) => {
      const entry = this.peers.get(remotePublicKey);
      if (entry) entry.dataChannel = event.channel;
      this.wireDataChannel(remotePublicKey, event.channel);
    };

    return pc;
  }

  private wireDataChannel(remotePublicKey: string, channel: RTCDataChannel): void {
    channel.onopen = () => this.setState(remotePublicKey, "connected");
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
    let entry = this.peers.get(from);

    if (payload.kind === "offer") {
      const stale = !entry || entry.pc.connectionState === "closed" || entry.pc.connectionState === "failed";
      const pc = stale ? this.createPeerConnection(from) : entry!.pc;
      if (stale) {
        entry = { pc, dataChannel: null, state: "connecting" };
        this.peers.set(from, entry);
        this.setState(from, "connecting");
      }
      await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.sendSignal(from, { kind: "answer", sdp: answer.sdp } as SignalPayload);
      return;
    }

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
      return;
    }
  }

  private setState(peerPublicKey: string, state: ConnectionState): void {
    const entry = this.peers.get(peerPublicKey);
    if (entry) entry.state = state;
    this.callbacks.onStateChange(peerPublicKey, state);
  }
}
