import pg from "pg";

const { Pool } = pg;

/**
 * Only account credentials and each account's current WebRTC public key
 * live here — never chat content. Chat history stays on-device only, in
 * the terminal client's local storage.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      public_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  public_key: string | null;
}

export async function createUser(username: string, passwordHash: string): Promise<UserRow> {
  const result = await pool.query<UserRow>(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2)
     RETURNING id, username, password_hash, public_key`,
    [username, passwordHash],
  );
  return result.rows[0];
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>(
    `SELECT id, username, password_hash, public_key FROM users WHERE username = $1`,
    [username],
  );
  return result.rows[0] ?? null;
}

export async function setUserPublicKey(username: string, publicKey: string): Promise<void> {
  await pool.query(`UPDATE users SET public_key = $1 WHERE username = $2`, [publicKey, username]);
}
