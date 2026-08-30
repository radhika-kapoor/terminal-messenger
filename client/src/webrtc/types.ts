export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "peer-offline"
  | "failed"
  | "closed";

export type SignalPayload =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | {
      kind: "ice-candidate";
      candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
    };
