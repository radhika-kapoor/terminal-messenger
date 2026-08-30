import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}

export interface TokenPayload {
  username: string;
}

export function issueToken(username: string): string {
  return jwt.sign({ username } satisfies TokenPayload, JWT_SECRET as string, { expiresIn: "30d" });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET as string);
    if (typeof decoded === "object" && decoded !== null && typeof decoded.username === "string") {
      return { username: decoded.username };
    }
    return null;
  } catch {
    return null;
  }
}
