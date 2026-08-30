#!/usr/bin/env node
import readline from "node:readline";
import { registerAccount, loginAccount, lookupPublicKey, AuthError } from "./auth.js";
import { promptHidden } from "./cli/prompt.js";
import { getOrCreateIdentity } from "./crypto/identity.js";
import { saveToken, loadToken } from "./storage/session.js";
import { appendMessage, loadHistory } from "./storage/messages.js";
import { WebRTCManager } from "./webrtc/manager.js";
import type { ConnectionState } from "./webrtc/types.js";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  terminal-messenger register <username>",
      "  terminal-messenger login <username>",
      "  terminal-messenger chat <username> <contact>",
    ].join("\n"),
  );
  process.exit(1);
}

async function cmdRegister(username: string): Promise<void> {
  const password = await promptHidden("Password: ");
  const confirm = await promptHidden("Confirm password: ");
  if (password !== confirm) {
    console.error("Passwords did not match.");
    process.exit(1);
  }
  try {
    const identity = getOrCreateIdentity(username); // generates and persists the local keypair
    const token = await registerAccount(username, password, identity.publicKey);
    saveToken(username, token);
    console.log(`Registered ${username}. You're logged in — run "chat ${username} <contact>" to start.`);
  } catch (err) {
    console.error(err instanceof AuthError ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdLogin(username: string): Promise<void> {
  const password = await promptHidden("Password: ");
  try {
    const identity = getOrCreateIdentity(username);
    const token = await loginAccount(username, password, identity.publicKey);
    saveToken(username, token);
    console.log(`Logged in as ${username}.`);
  } catch (err) {
    console.error(err instanceof AuthError ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdChat(username: string, contact: string): Promise<void> {
  const token = loadToken(username);
  if (!token) {
    console.error(`Not logged in as ${username}. Run "login ${username}" first.`);
    process.exit(1);
  }

  const identity = getOrCreateIdentity(username);

  console.log(`Looking up ${contact}...`);
  let contactPublicKey: string | null;
  try {
    contactPublicKey = await lookupPublicKey(token, contact);
  } catch (err) {
    console.error(err instanceof AuthError ? err.message : String(err));
    process.exit(1);
  }
  if (!contactPublicKey) {
    console.error(`${contact} hasn't registered yet, or has never come online.`);
    process.exit(1);
  }

  for (const message of loadHistory(username, contact)) {
    const who = message.direction === "sent" ? "you" : contact;
    console.log(`[${message.timestamp}] ${who}: ${message.text}`);
  }

  let lastState: ConnectionState = "idle";
  const manager = new WebRTCManager(token, identity.publicKey, identity.secretKey, {
    onMessage: (_from, plaintext) => {
      const timestamp = new Date().toISOString();
      appendMessage(username, contact, { direction: "received", text: plaintext, timestamp });
      console.log(`\n${contact}: ${plaintext}`);
      rl.prompt();
    },
    onStateChange: (_peer, state) => {
      if (state === lastState) return;
      lastState = state;
      console.log(`\n[connection: ${state}]`);
      rl.prompt();
    },
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  console.log(`Connecting to ${contact}... (type /quit to exit)`);
  await manager.connectToPeer(contactPublicKey);

  rl.prompt();
  rl.on("line", (line) => {
    const text = line.trim();
    if (text === "/quit") {
      manager.destroy();
      rl.close();
      process.exit(0);
    }
    if (!text) {
      rl.prompt();
      return;
    }

    const sent = manager.sendMessage(contactPublicKey!, text);
    if (sent) {
      appendMessage(username, contact, { direction: "sent", text, timestamp: new Date().toISOString() });
    } else {
      console.log(`(not connected yet — message not sent: ${text})`);
    }
    rl.prompt();
  });
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (command === "register" && args[0]) return cmdRegister(args[0]);
  if (command === "login" && args[0]) return cmdLogin(args[0]);
  if (command === "chat" && args[0] && args[1]) return cmdChat(args[0], args[1]);
  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
