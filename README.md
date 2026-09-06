# Terminal Messenger

A P2P chat client you run from the terminal. Two accounts connect directly
over a WebRTC DataChannel; every message is end-to-end encrypted with each
user's own keypair before it's sent. Chat history lives only on your own
machine — the server never sees or stores message content.

Each account runs a small local **daemon** that owns the network connection
and a per-contact **send queue**: if a contact is offline when you send,
the message is queued to disk and delivered automatically the moment the
daemon hears they've come back online — without the server ever storing it
in the meantime.

## How it works

- **Accounts**: a small server (`server/`) authenticates registered users
  with a username + password (bcrypt-hashed, stored in Postgres). This is
  the only thing Postgres stores — no chat content ever touches it.
- **Identity**: on first `register`/`login`, your terminal client generates
  an X25519 keypair (`tweetnacl`) locally under `~/.terminal-messenger/`.
  The secret key never leaves your machine; the public key is uploaded to
  the server so contacts can find it.
- **The daemon**: `daemon start <username>` launches a background process
  per account that holds the one signaling-relay connection, every WebRTC
  peer connection, and the local message queue. The terminal commands
  (`chat`, `send`) are thin clients that talk to it over a local Unix
  socket (`~/.terminal-messenger/<user>/daemon.sock`) — that socket never
  leaves your machine either.
- **Finding a contact**: your daemon asks the server "what's `<username>`'s
  public key?" (`GET /users/:username`) — this is the server's directory
  lookup, replacing a raw public-IP exchange with something that actually
  works behind NAT. A reverse lookup (`GET /users/by-key/:publicKey`)
  handles the case where a contact messages you first, before your daemon
  has ever looked them up.
- **Connecting**: your daemon and theirs both connect to the server's
  WebSocket relay (`/relay`). The relay's only job is forwarding opaque
  WebRTC offer/answer/ICE messages between two authenticated public keys so
  a direct connection can be negotiated — it never sees message content,
  and stores nothing about the exchange (in-memory only). The relay also
  supports **watch**: a daemon can ask "tell me when this public key comes
  online," which is what drives automatic queue delivery.
- **NAT traversal**: connection setup tries public STUN servers first, and
  falls back to TURN relay servers when direct hole-punching can't succeed
  (common with mobile data, CGNAT, or restrictive firewalls). A TURN relay
  only ever forwards already-encrypted DataChannel bytes — never plaintext,
  and it doesn't require your router to accept any inbound connection it
  didn't ask for.
- **Messaging**: once the WebRTC DataChannel is open, messages flow
  directly machine-to-machine. Each message is additionally encrypted with
  `nacl.box(senderSecretKey, recipientPublicKey)`, so only the intended
  recipient can ever decrypt it — regardless of what the relay, a TURN
  server, or the network in between does.
- **Offline queueing**: if a contact isn't reachable right now, your daemon
  writes the message to a local queue file
  (`~/.terminal-messenger/<you>/queue/<contact>.jsonl`) and asks the relay
  to watch for them. The queue is scanned again on every daemon startup, so
  it survives restarts (e.g. a reboot) — nothing about it is ever visible
  to the server.
- **Storage**: chat history is appended to a local JSONL file per contact
  under `~/.terminal-messenger/<you>/history/<contact>.jsonl`. Nothing is
  ever sent back to the server.

## Layout

```
server/   Node.js + TypeScript: HTTP auth (register/login/lookup) + WebSocket
          signaling relay (with watch/peer-online support). Deploy this
          once, to Railway or anywhere else.
client/   Node.js + TypeScript: the daemon (client/src/daemon/) plus a thin
          CLI (client/src/index.ts). Each user runs this locally.
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
export SERVER_URL=http://localhost:8787   # or your Railway URL

node dist/index.js register alice
node dist/index.js daemon start alice
node dist/index.js chat alice bob
```

Commands:

- `register <username>` — create an account (prompts for a password) and
  generate your local identity keypair.
- `login <username>` — log an existing account back in on this machine
  (prompts for a password).
- `daemon start <username>` — start the background daemon for this
  account. Safe to leave running indefinitely; it's what actually sends,
  receives, and queues messages.
- `daemon stop <username>` / `daemon status <username>` — stop it, or
  check whether it's running.
- `send <username> <contact> <message...>` — one-shot send. Starts the
  daemon automatically if it isn't already running. Prints whether the
  message went out immediately or was queued.
- `chat <username> <contact>` — interactive session: replays local
  history, then shows live messages and connection state. `/quit` exits
  the chat view only — the daemon (and delivery of anything still queued)
  keeps running in the background.

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

- **No perfect negotiation.** If both sides' daemons start a connection
  attempt at the exact same instant, one offer can be dropped — the next
  `peer-online` retry (or a manual `send`) recovers it.
- **No forward secrecy yet.** Messages are encrypted with each side's
  long-term identity key, not a rotating session key (no Double Ratchet).
- **TURN is a shared free tier by default.** `client/src/config.ts` points
  at Open Relay Project's public TURN servers to work out of the box — fine
  for testing, but no uptime guarantee. Self-hosting `coturn` (or a paid
  TURN provider) is the durable fix for anything you depend on.
- `werift`'s ICE dependency pulls in a transitively vulnerable `ip` package
  (GHSA-2p57-rm9w-gvfp, no fix available upstream) — it's a SSRF-related
  issue in IP-range categorization, not exploitable via this client's own
  usage, but worth knowing about if you audit dependencies.
