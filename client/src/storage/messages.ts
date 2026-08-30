import fs from "node:fs";
import path from "node:path";
import { historyDir } from "./paths.js";

export interface StoredMessage {
  direction: "sent" | "received";
  text: string;
  timestamp: string; // ISO 8601
}

function historyPath(username: string, contact: string): string {
  return path.join(historyDir(username), `${contact}.jsonl`);
}

/** Appends one message to this contact's local history. Never sent to the server. */
export function appendMessage(username: string, contact: string, message: StoredMessage): void {
  fs.appendFileSync(historyPath(username, contact), JSON.stringify(message) + "\n", { mode: 0o600 });
}

export function loadHistory(username: string, contact: string): StoredMessage[] {
  const file = historyPath(username, contact);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredMessage);
}
