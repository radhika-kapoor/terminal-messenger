#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { registerAccount, loginAccount, AuthError } from "./auth.js";
import { promptHidden } from "./cli/prompt.js";
import { getOrCreateIdentity } from "./crypto/identity.js";
import { saveToken, loadToken } from "./storage/session.js";
import { loadHistory } from "./storage/messages.js";
import { daemonLogPath, daemonPidPath, daemonSocketPath } from "./storage/paths.js";
import { connectToDaemon, sendToDaemon } from "./daemon/ipc.js";
import { LineDecoder, type DaemonToCli } from "./daemon/protocol.js";

function usage(): never {
  console.error(
    [
      "Usage:",
      "  terminal-messenger register <username>",
      "  terminal-messenger login <username>",
      "  terminal-messenger daemon start <username>",
      "  terminal-messenger daemon stop <username>",
      "  terminal-messenger daemon status <username>",
      "  terminal-messenger send <username> <contact> <message...>",
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
    console.log(`Registered ${username}. Run "daemon start ${username}" then "chat ${username} <contact>".`);
    process.exit(0);
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
    process.exit(0);
  } catch (err) {
    console.error(err instanceof AuthError ? err.message : String(err));
    process.exit(1);
  }
}

// --- daemon process management -------------------------------------------

function readDaemonPid(username: string): number | null {
  const file = daemonPidPath(username);
  if (!fs.existsSync(file)) return null;
  const pid = Number(fs.readFileSync(file, "utf8").trim());
  return Number.isFinite(pid) ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "daemon", "index.js");
}

async function waitForSocket(username: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const socket = await connectToDaemon(daemonSocketPath(username));
      socket.end();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("daemon did not start in time — check " + daemonLogPath(username));
}

async function startDaemon(username: string): Promise<void> {
  const existing = readDaemonPid(username);
  if (existing && isProcessAlive(existing)) {
    console.log(`Daemon already running for ${username} (pid ${existing}).`);
    return;
  }

  const logFd = fs.openSync(daemonLogPath(username), "a");
  const child = spawn(process.execPath, [daemonEntryPath(), username], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  await waitForSocket(username);
  console.log(`Daemon started for ${username} (pid ${child.pid}). Logs: ${daemonLogPath(username)}`);
}

function stopDaemon(username: string): void {
  const pid = readDaemonPid(username);
  if (!pid || !isProcessAlive(pid)) {
    console.log(`No daemon running for ${username}.`);
    process.exit(0);
  }
  process.kill(pid, "SIGTERM");
  console.log(`Stopped daemon for ${username} (pid ${pid}).`);
  process.exit(0);
}

function daemonStatus(username: string): void {
  const pid = readDaemonPid(username);
  if (pid && isProcessAlive(pid)) {
    console.log(`Daemon running for ${username} (pid ${pid}).`);
  } else {
    console.log(`No daemon running for ${username}.`);
  }
  process.exit(0);
}

async function ensureDaemon(username: string): Promise<void> {
  const pid = readDaemonPid(username);
  if (pid && isProcessAlive(pid)) return;
  console.log(`Starting daemon for ${username}...`);
  await startDaemon(username);
}

// --- thin CLI commands that talk to the daemon ----------------------------

async function cmdSend(username: string, contact: string, text: string): Promise<void> {
  if (!loadToken(username)) {
    console.error(`Not logged in as ${username}. Run "login ${username}" first.`);
    process.exit(1);
  }
  await ensureDaemon(username);

  const socket = await connectToDaemon(daemonSocketPath(username));
  const decoder = new LineDecoder<DaemonToCli>();

  const timeout = setTimeout(() => {
    console.error("No response from daemon after 15s — check its log for errors.");
    socket.end();
    process.exit(1);
  }, 15000);

  socket.on("data", (chunk) => {
    for (const msg of decoder.push(chunk)) {
      if (msg.type === "message" && msg.contact === contact && msg.direction === "sent") {
        clearTimeout(timeout);
        console.log(`Sent to ${contact}: ${msg.text}`);
        socket.end();
        process.exit(0);
      }
      if (msg.type === "queued" && msg.contact === contact) {
        clearTimeout(timeout);
        console.log(`${contact} is offline — queued locally, will send automatically once they're back.`);
        socket.end();
        process.exit(0);
      }
      if (msg.type === "error" && msg.contact === contact) {
        clearTimeout(timeout);
        console.error(msg.message);
        socket.end();
        process.exit(1);
      }
    }
  });

  sendToDaemon(socket, { type: "send", contact, text });
}

async function cmdChat(username: string, contact: string): Promise<void> {
  if (!loadToken(username)) {
    console.error(`Not logged in as ${username}. Run "login ${username}" first.`);
    process.exit(1);
  }
  await ensureDaemon(username);

  for (const message of loadHistory(username, contact)) {
    const who = message.direction === "sent" ? "you" : contact;
    console.log(`[${message.timestamp}] ${who}: ${message.text}`);
  }

  const socket = await connectToDaemon(daemonSocketPath(username));
  const decoder = new LineDecoder<DaemonToCli>();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

  socket.on("data", (chunk) => {
    for (const msg of decoder.push(chunk)) {
      if (msg.type === "message") {
        const who = msg.direction === "sent" ? "you" : contact;
        console.log(`\n${who}: ${msg.text}`);
      } else if (msg.type === "state") {
        console.log(`\n[connection: ${msg.state}]`);
      } else if (msg.type === "queued") {
        console.log(`\n(${contact} is offline — queued: ${msg.text})`);
      } else if (msg.type === "error") {
        console.log(`\n(error: ${msg.message})`);
      }
      rl.prompt();
    }
  });

  socket.on("close", () => {
    console.log("\n(lost connection to daemon)");
    process.exit(1);
  });

  sendToDaemon(socket, { type: "subscribe", contact });

  console.log(`Chatting with ${contact} (type /quit to exit — the daemon keeps running so messages still arrive).`);
  rl.prompt();
  rl.on("line", (line) => {
    const text = line.trim();
    if (text === "/quit") {
      sendToDaemon(socket, { type: "unsubscribe", contact });
      socket.end();
      rl.close();
      process.exit(0);
    }
    if (!text) {
      rl.prompt();
      return;
    }
    sendToDaemon(socket, { type: "send", contact, text });
  });
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (command === "register" && args[0]) return cmdRegister(args[0]);
  if (command === "login" && args[0]) return cmdLogin(args[0]);
  if (command === "daemon" && args[0] === "start" && args[1]) {
    await startDaemon(args[1]);
    process.exit(0);
  }
  if (command === "daemon" && args[0] === "stop" && args[1]) return stopDaemon(args[1]);
  if (command === "daemon" && args[0] === "status" && args[1]) return daemonStatus(args[1]);
  if (command === "send" && args[0] && args[1] && args[2]) return cmdSend(args[0], args[1], args.slice(2).join(" "));
  if (command === "chat" && args[0] && args[1]) return cmdChat(args[0], args[1]);
  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
