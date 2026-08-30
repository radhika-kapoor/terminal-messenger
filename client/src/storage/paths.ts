import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ROOT_DIR = path.join(os.homedir(), ".terminal-messenger");

/**
 * Everything under here is local to this machine and this account only —
 * identity secret key, auth session, and chat history. Nothing in this
 * tree is ever sent to the server.
 */
export function accountDir(username: string): string {
  const dir = path.join(ROOT_DIR, username);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function historyDir(username: string): string {
  const dir = path.join(accountDir(username), "history");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
