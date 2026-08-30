import fs from "node:fs";
import path from "node:path";
import { accountDir } from "./paths.js";

function sessionPath(username: string): string {
  return path.join(accountDir(username), "session.json");
}

export function saveToken(username: string, token: string): void {
  fs.writeFileSync(sessionPath(username), JSON.stringify({ token }), { mode: 0o600 });
}

export function loadToken(username: string): string | null {
  const file = sessionPath(username);
  if (!fs.existsSync(file)) return null;
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { token: string };
  return stored.token;
}
