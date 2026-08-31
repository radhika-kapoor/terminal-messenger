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

export function queueDir(username: string): string {
  const dir = path.join(accountDir(username), "queue");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Path to the daemon's Unix domain socket for this account. */
export function daemonSocketPath(username: string): string {
  return path.join(accountDir(username), "daemon.sock");
}

/** Path to the daemon's pidfile for this account. */
export function daemonPidPath(username: string): string {
  return path.join(accountDir(username), "daemon.pid");
}

/** Path to the daemon's log file for this account. */
export function daemonLogPath(username: string): string {
  return path.join(accountDir(username), "daemon.log");
}
