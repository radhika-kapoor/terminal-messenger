# Terminal Messenger

A P2P chat client you run from the terminal. Two accounts connect directly
over a WebRTC DataChannel; every message is end-to-end encrypted with each
user's own keypair before it's sent. Chat history lives only on your own
machine — the server never sees or stores message content.

## How it works

- **Accounts**: a small server (`server/`) authenticates registered users
  with a username + password (bcrypt-hashed, stored in Postgres). This is
  the only thing Postgres stores — no chat content ever touches it.
- **Identity**: on first `register`/`login`, your terminal client generates
  an X25519 keypair (`tweetnacl`) locally under `~/.terminal-messenger/`.
  The secret key never leaves your machine; the public key is uploaded to
  the server so contacts can find it.
- **Finding a contact**: to chat with someone, your client asks the server
  "what's `<username>`'s public key?" (`GET /users/:username`) — this is
  the server's directory lookup, replacing a raw public-IP exchange with
  something that actually works behind NAT.
- **Connecting**: your client and theirs both connect to the server's
  WebSocket relay (`/relay`). The relay's only job is forwarding opaque
  WebRTC offer/answer/ICE messages between two authenticated public keys so
  a direct connection can be negotiated — it never sees message content,
  and stores nothing about the exchange (in-memory only).
- **Messaging**: once the WebRTC DataChannel is open, messages flow
  directly machine-to-machine. Each message is additionally encrypted with
  `nacl.box(senderSecretKey, recipientPublicKey)`, so only the intended
  recipient can ever decrypt it — regardless of what the relay or network
  does.
- **Storage**: chat history is appended to a local JSONL file per contact
  under `~/.terminal-messenger/<you>/history/<contact>.jsonl`. Nothing is
  ever sent back to the server.

## Layout

```
server/   Node.js + TypeScript: HTTP auth (register/login/lookup) + WebSocket
          signaling relay. Deploy this once, to Railway or anywhere else.
client/   Node.js + TypeScript terminal client (werift for WebRTC). Each
          user runs this locally.
```

## Running the server

Requires a Postgres database.

```sh
cd server
npm install
cp .env.example .env   # fill in JWT_SECRET and DATABASE_URL for local dev
npm run dev             # listens on http://0.0.0.0:8787 by default
```

## Running the client

```sh
cd client
npm install
npm run build
SERVER_URL=http://localhost:8787 node dist/index.js register alice
SERVER_URL=http://localhost:8787 node dist/index.js chat alice bob
```

Commands:

- `register <username>` — create an account (prompts for a password),
  generates your local identity keypair, and logs you in.
- `login <username>` — log an existing account back in on this machine
  (prompts for a password).
- `chat <username> <contact>` — connect to `<contact>` and open an
  interactive chat. Both people need to be running `chat` (or otherwise
  connected to the relay) around the same time to complete the handshake —
  there's no server-side store-and-forward, by design, since a store-and-
  forward server would mean a server holding message data.

Set `SERVER_URL` once in your shell profile to avoid retyping it, e.g.
`export SERVER_URL=https://your-app.up.railway.app`.

## Deploying the server to Railway

1. Push this repo (or at least `server/`) to GitHub.
2. In Railway, create a new project → **Deploy from GitHub repo**.
3. If your repo root is `terminal-Messenger/` (server + client together),
   set this service's **Root Directory** to `server` in Settings → Source.
4. Add a **Postgres** plugin to the project (New → Database → PostgreSQL).
   Railway automatically injects `DATABASE_URL` into your service — no
   manual wiring needed.
5. In your service's Variables, set `JWT_SECRET` to a long random value
   (e.g. `openssl rand -hex 32`). `PORT` is injected by Railway
   automatically; don't set it yourself.
6. Deploy. Under Settings → Networking, generate a public domain — this
   is the `SERVER_URL` your terminal clients will point at (the WebSocket
   relay lives at `wss://<that-domain>/relay`, derived automatically by the
   client from `SERVER_URL`).

## Known limitations (by design, for this version)

- **No store-and-forward.** Both people need to be online and connected to
  the relay at the same time to exchange messages.
- **No forward secrecy yet.** Messages are encrypted with each side's
  long-term identity key, not a rotating session key (no Double Ratchet).
- **No perfect negotiation.** If both sides start `chat` at the exact same
  instant, one offer can be dropped — just retry.
- **STUN only, no TURN.** NAT traversal uses public STUN; the small
  minority of NATs that need a TURN relay to connect aren't supported yet.
  Self-hosting `coturn` and adding it to `ICE_SERVERS` in
  `client/src/config.ts` would only ever relay ciphertext, never store
  anything.
- `werift`'s ICE dependency pulls in a transitively vulnerable `ip` package
  (GHSA-2p57-rm9w-gvfp, no fix available upstream) — it's a SSRF-related
  issue in IP-range categorization, not exploitable via this client's own
  usage, but worth knowing about if you audit dependencies.
