import fs from "node:fs";
import path from "node:path";
import { queueDir } from "./paths.js";

export interface QueuedMessage {
  text: string;
  timestamp: string; // ISO 8601, when it was queued
}

function queuePath(username: string, contact: string): string {
  return path.join(queueDir(username), `${contact}.jsonl`);
}

/** Appends a message to this contact's local send queue. Never sent to the server. */
export function enqueueMessage(username: string, contact: string, text: string): void {
  const entry: QueuedMessage = { text, timestamp: new Date().toISOString() };
  fs.appendFileSync(queuePath(username, contact), JSON.stringify(entry) + "\n", { mode: 0o600 });
}

/** Reads and clears everything queued for this contact, in send order. */
export function drainQueue(username: string, contact: string): QueuedMessage[] {
  const file = queuePath(username, contact);
  if (!fs.existsSync(file)) return [];
  const messages = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as QueuedMessage);
  fs.rmSync(file);
  return messages;
}

/** Contacts with at least one message waiting to be sent. */
export function listQueuedContacts(username: string): string[] {
  const dir = queueDir(username);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length));
}
