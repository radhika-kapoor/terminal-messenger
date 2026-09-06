import "dotenv/config";
import http from "node:http";
import bcrypt from "bcryptjs";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { initDb, createUser, findUserByUsername, findUserByPublicKey, setUserPublicKey } from "./db.js";
import { issueToken, verifyToken } from "./auth.js";
import { parseClientMessage, isValidPublicKey, type ServerToClient } from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8787);
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

const app = express();
app.use(express.json());

app.post("/register", async (req, res) => {
  const { username, password, publicKey } = req.body ?? {};
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    res.status(400).json({ error: "username must be 3-32 chars: letters, numbers, _ or -" });
    return;
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  if (publicKey !== undefined && !isValidPublicKey(publicKey)) {
    res.status(400).json({ error: "publicKey is malformed" });
    return;
  }

  const existing = await findUserByUsername(username);
  if (existing) {
    res.status(409).json({ error: "username already taken" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await createUser(username, passwordHash);
  // Publishing the public key immediately (not just on WS connect) lets two
  // brand-new contacts find each other even before either has opened a live
  // signaling connection.
  if (publicKey) await setUserPublicKey(username, publicKey);
  res.status(201).json({ token: issueToken(username) });
});

app.post("/login", async (req, res) => {
  const { username, password, publicKey } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  if (publicKey !== undefined && !isValidPublicKey(publicKey)) {
    res.status(400).json({ error: "publicKey is malformed" });
    return;
  }

  const user = await findUserByUsername(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: "invalid username or password" });
    return;
  }

  if (publicKey) await setUserPublicKey(username, publicKey);
  res.json({ token: issueToken(username) });
});

// Looks up a contact's current WebRTC public key so a client can start a
// direct P2P connection to them — requires the caller to be authenticated.
app.get("/users/:username", async (req, res) => {
  const auth = req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (!token || !verifyToken(token)) {
    res.status(401).json({ error: "missing or invalid authorization" });
    return;
  }

  const user = await findUserByUsername(req.params.username);
  if (!user || !user.public_key) {
    res.status(404).json({ error: "user not found or not yet online" });
    return;
  }

  res.json({ username: user.username, publicKey: user.public_key });
});

// Reverse lookup: a daemon that receives an inbound connection from a
// public key it doesn't recognize yet (a contact messaging it for the
// first time this run) uses this to find out who that is.
app.get("/users/by-key/:publicKey", async (req, res) => {
  const auth = req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (!token || !verifyToken(token)) {
    res.status(401).json({ error: "missing or invalid authorization" });
    return;
  }
  if (!isValidPublicKey(req.params.publicKey)) {
    res.status(400).json({ error: "publicKey is malformed" });
    return;
  }

  const user = await findUserByPublicKey(req.params.publicKey);
  if (!user) {
    res.status(404).json({ error: "no account with that public key" });
    return;
  }

  res.json({ username: user.username, publicKey: user.public_key });
});

const server = http.createServer(app);

// publicKey -> live socket. In-memory only, nothing ever touches disk.
const peers = new Map<string, WebSocket>();

// watched publicKey -> sockets that asked to be told when it comes online.
// Also in-memory only — just lets an offline sender's daemon know when to
// retry, nothing about the queued message itself is ever visible here.
const watchers = new Map<string, Set<WebSocket>>();

function send(socket: WebSocket, message: ServerToClient): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (socket) => {
  let registeredKey: string | null = null;
  const watchedKeys = new Set<string>();

  socket.on("message", (raw) => {
    const msg = parseClientMessage(raw.toString());
    if (!msg) {
      send(socket, { type: "error", message: "malformed message" });
      return;
    }

    if (msg.type === "register") {
      const payload = verifyToken(msg.token);
      if (!payload) {
        send(socket, { type: "error", message: "invalid or expired token" });
        socket.close();
        return;
      }

      // A reconnect from the same identity replaces the old socket.
      const existing = peers.get(msg.publicKey);
      if (existing && existing !== socket) existing.close();

      registeredKey = msg.publicKey;
      peers.set(msg.publicKey, socket);
      setUserPublicKey(payload.username, msg.publicKey).catch((err) =>
        console.error("[signaling] failed to persist public key", err),
      );
      send(socket, { type: "registered", publicKey: msg.publicKey });
      console.log(`[signaling] registered ${payload.username} (${msg.publicKey.slice(0, 8)}…)`);

      // Anyone waiting to know this key came online gets told now.
      for (const watcher of watchers.get(msg.publicKey) ?? []) {
        send(watcher, { type: "peer-online", publicKey: msg.publicKey });
      }
      return;
    }

    if (msg.type === "signal") {
      if (!registeredKey) {
        send(socket, { type: "error", message: "register before signaling" });
        return;
      }
      const target = peers.get(msg.to);
      if (!target) {
        send(socket, { type: "peer-offline", publicKey: msg.to });
        return;
      }
      // Opaque forward: the relay does not parse `payload` (SDP/ICE/etc).
      send(target, { type: "signal", from: registeredKey, payload: msg.payload });
      return;
    }

    if (msg.type === "watch") {
      if (!registeredKey) {
        send(socket, { type: "error", message: "register before watching" });
        return;
      }
      let set = watchers.get(msg.publicKey);
      if (!set) {
        set = new Set();
        watchers.set(msg.publicKey, set);
      }
      set.add(socket);
      watchedKeys.add(msg.publicKey);

      // Already online right now — no need to wait for a future register.
      if (peers.has(msg.publicKey)) {
        send(socket, { type: "peer-online", publicKey: msg.publicKey });
      }
      return;
    }
  });

  socket.on("close", () => {
    if (registeredKey && peers.get(registeredKey) === socket) {
      peers.delete(registeredKey);
      console.log(`[signaling] disconnected ${registeredKey.slice(0, 8)}…`);
    }
    for (const key of watchedKeys) {
      const set = watchers.get(key);
      set?.delete(socket);
      if (set && set.size === 0) watchers.delete(key);
    }
  });
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[server] listening on http://0.0.0.0:${PORT} (WS relay at /relay)`);
    });
  })
  .catch((err) => {
    console.error("[server] failed to initialize database", err);
    process.exit(1);
  });
