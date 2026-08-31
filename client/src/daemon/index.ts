import fs from "node:fs";
import type net from "node:net";
import { lookupPublicKey, lookupUsername } from "../auth.js";
import { getOrCreateIdentity } from "../crypto/identity.js";
import { loadToken } from "../storage/session.js";
import { daemonPidPath, daemonSocketPath } from "../storage/paths.js";
import { appendMessage } from "../storage/messages.js";
import { enqueueMessage, drainQueue, listQueuedContacts } from "../storage/queue.js";
import { WebRTCManager } from "../webrtc/manager.js";
import { createDaemonServer, sendToCli } from "./ipc.js";
import type { CliToDaemon, DaemonToCli } from "./protocol.js";

const username = process.argv[2];
if (!username) {
  console.error("usage: daemon <username>");
  process.exit(1);
}

const token = loadToken(username);
if (!token) {
  console.error(`not logged in as ${username}`);
  process.exit(1);
}

const identity = getOrCreateIdentity(username);

// contact username <-> public key, resolved lazily and cached for this run.
const contactToKey = new Map<string, string>();
const keyToContact = new Map<string, string>();
const resolvingByKey = new Map<string, Promise<string>>();

// contact username -> CLI sockets currently watching it.
const subscriptions = new Map<string, Set<net.Socket>>();

async function resolveByUsername(contact: string): Promise<string | null> {
  const cached = contactToKey.get(contact);
  if (cached) return cached;
  const key = await lookupPublicKey(token!, contact);
  if (key) {
    contactToKey.set(contact, key);
    keyToContact.set(key, contact);
  }
  return key;
}

/** Falls back to a shortened key label if the account can't be identified. */
async function resolveByKey(publicKey: string): Promise<string> {
  const cached = keyToContact.get(publicKey);
  if (cached) return cached;

  let pending = resolvingByKey.get(publicKey);
  if (!pending) {
    pending = (async () => {
      const found = await lookupUsername(token!, publicKey).catch(() => null);
      const contact = found ?? `unknown-${publicKey.slice(0, 8)}`;
      contactToKey.set(contact, publicKey);
      keyToContact.set(publicKey, contact);
      return contact;
    })();
    resolvingByKey.set(publicKey, pending);
  }
  const contact = await pending;
  resolvingByKey.delete(publicKey);
  return contact;
}

function broadcast(contact: string, message: DaemonToCli): void {
  for (const socket of subscriptions.get(contact) ?? []) sendToCli(socket, message);
}

async function flushQueue(contact: string, publicKey: string): Promise<void> {
  for (const queued of drainQueue(username!, contact)) {
    const sent = manager.sendMessage(publicKey, queued.text);
    if (!sent) {
      // Connection dropped again mid-flush — put it back and stop for now;
      // the next peer-online will retry.
      enqueueMessage(username!, contact, queued.text);
      return;
    }
    appendMessage(username!, contact, { direction: "sent", text: queued.text, timestamp: queued.timestamp });
    broadcast(contact, { type: "message", contact, direction: "sent", text: queued.text, timestamp: queued.timestamp });
  }
}

const manager = new WebRTCManager(token, identity.publicKey, identity.secretKey, {
  onMessage: (fromPublicKey, plaintext) => {
    resolveByKey(fromPublicKey)
      .then((contact) => {
        const timestamp = new Date().toISOString();
        appendMessage(username!, contact, { direction: "received", text: plaintext, timestamp });
        broadcast(contact, { type: "message", contact, direction: "received", text: plaintext, timestamp });
      })
      .catch((err) => console.error("[daemon] failed to resolve inbound sender", err));
  },
  onStateChange: (peerPublicKey, state) => {
    resolveByKey(peerPublicKey)
      .then((contact) => {
        broadcast(contact, { type: "state", contact, state });
        if (state === "connected") flushQueue(contact, peerPublicKey).catch((err) => console.error("[daemon] flush failed", err));
      })
      .catch((err) => console.error("[daemon] failed to resolve state-change peer", err));
  },
  onPeerOnline: (publicKey) => {
    manager.connectToPeer(publicKey).catch((err) => console.error("[daemon] connect on peer-online failed", err));
  },
});

// Anyone we already owe a message to — watch them now so we hear the moment
// they come online, even if nobody runs `chat`/`send` again to trigger it.
for (const contact of listQueuedContacts(username)) {
  resolveByUsername(contact)
    .then((key) => {
      if (key) {
        manager.watchPeer(key);
        manager.connectToPeer(key).catch(() => {});
      }
    })
    .catch((err) => console.error(`[daemon] failed to resolve queued contact ${contact}`, err));
}

async function handleSend(socket: net.Socket, contact: string, text: string): Promise<void> {
  let publicKey: string | null;
  try {
    publicKey = await resolveByUsername(contact);
  } catch (err) {
    sendToCli(socket, { type: "error", contact, message: `couldn't reach the server to look up ${contact}: ${err}` });
    return;
  }
  if (!publicKey) {
    sendToCli(socket, { type: "error", contact, message: `${contact} hasn't registered yet` });
    return;
  }

  if (manager.getState(publicKey) === "connected" && manager.sendMessage(publicKey, text)) {
    const timestamp = new Date().toISOString();
    appendMessage(username, contact, { direction: "sent", text, timestamp });
    broadcast(contact, { type: "message", contact, direction: "sent", text, timestamp });
    return;
  }

  enqueueMessage(username, contact, text);
  manager.watchPeer(publicKey);
  manager.connectToPeer(publicKey).catch(() => {});
  sendToCli(socket, { type: "queued", contact, text });
}

createDaemonServer(daemonSocketPath(username), {
  onMessage: (socket, message: CliToDaemon) => {
    if (message.type === "send") {
      handleSend(socket, message.contact, message.text).catch((err) =>
        sendToCli(socket, { type: "error", contact: message.contact, message: String(err) }),
      );
      return;
    }
    if (message.type === "subscribe") {
      let set = subscriptions.get(message.contact);
      if (!set) {
        set = new Set();
        subscriptions.set(message.contact, set);
      }
      set.add(socket);
      const key = contactToKey.get(message.contact);
      if (key) sendToCli(socket, { type: "state", contact: message.contact, state: manager.getState(key) });
      return;
    }
    if (message.type === "unsubscribe") {
      subscriptions.get(message.contact)?.delete(socket);
      return;
    }
    if (message.type === "ping") {
      sendToCli(socket, { type: "pong" });
      return;
    }
  },
  onDisconnect: (socket) => {
    for (const set of subscriptions.values()) set.delete(socket);
  },
});

fs.writeFileSync(daemonPidPath(username), String(process.pid));
console.log(`[daemon] started for ${username} (pid ${process.pid})`);

function shutdown(): void {
  console.log("[daemon] shutting down");
  manager.destroy();
  try {
    fs.rmSync(daemonPidPath(username));
  } catch {
    // already gone
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
