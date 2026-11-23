import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

// Accounts for the hosted server (milestone 3): email + password, one world per account.
// Passwords are kept as scrypt hashes (N = 2^15, r = 8, p = 1, 64-byte key, 16-byte salt).
// A sign-in gets a random 256-bit session token in an HttpOnly cookie; only its SHA-256 is
// stored, so the database alone cannot be used to sign in. Sessions last 30 days.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const SESSION_DAYS = 30
export const MIN_PASSWORD = 10

export interface User {
  id: string
  email: string
  createdAt: number
}

export class AccountError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const normaliseEmail = (e: string) => e.trim().toLowerCase()
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(pw, salt, 64, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$')
  if (alg !== 'scrypt' || !salt || !key) return false
  const want = Buffer.from(key, 'base64')
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem })
  return got.length === want.length && timingSafeEqual(got, want)
}

export class Accounts {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(path: string, now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.now = now
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        pass TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    `)
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n)
  }

  async signUp(email: string, password: string): Promise<User> {
    const e = normaliseEmail(email)
    if (!EMAIL.test(e) || e.length > 254) throw new AccountError(400, 'That does not look like an email address.')
    if (password.length < MIN_PASSWORD) throw new AccountError(400, `Use a password of at least ${MIN_PASSWORD} characters.`)
    if (password.length > 1024) throw new AccountError(400, 'That password is too long.')
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(e)) throw new AccountError(409, 'An account with that email already exists. Sign in instead.')
    const user: User = { id: randomUUID(), email: e, createdAt: this.now() }
    this.db.prepare('INSERT INTO users (id, email, pass, created_at) VALUES (?, ?, ?, ?)').run(user.id, user.email, await hashPassword(password), user.createdAt)
    return user
  }

  async signIn(email: string, password: string): Promise<User> {
    const row = this.db.prepare('SELECT id, email, pass, created_at FROM users WHERE email = ?').get(normaliseEmail(email)) as
      | { id: string; email: string; pass: string; created_at: number }
      | undefined
    // Hash anyway when the user is unknown, so timing does not reveal which emails exist.
    const ok = await verifyPassword(password, row?.pass ?? DUMMY_HASH)
    if (!row || !ok) throw new AccountError(401, 'Wrong email or password.')
    return { id: row.id, email: row.email, createdAt: row.created_at }
  }

  /** A new session for `userId`; returns the token for the cookie (never stored in clear). */
  createSession(userId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const expiresAt = now + SESSION_DAYS * 86_400_000
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now, expiresAt)
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    return { token, expiresAt }
  }

  userForToken(token: string | undefined): User | null {
    if (!token || token.length > 200) return null
    const row = this.db
      .prepare('SELECT u.id, u.email, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .get(sha256(token), this.now()) as { id: string; email: string; created_at: number } | undefined
    return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null
  }

  endSession(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
  }

  close(): void {
    this.db.close()
  }
}

// A real scrypt hash of a random password, for constant-time misses.
const DUMMY_HASH = `scrypt$${SCRYPT.N}$8$1$${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`

/** Fixed-window attempt limiter (sign-in and sign-up), per key. */
export class RateLimit {
  private readonly hits = new Map<string, { n: number; until: number }>()
  private readonly max: number
  private readonly windowMs: number
  private readonly now: () => number
  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max
    this.windowMs = windowMs
    this.now = now
  }

  /** Count one attempt; false when the key is over its limit. */
  take(key: string): boolean {
    const t = this.now()
    const h = this.hits.get(key)
    if (!h || h.until <= t) {
      this.hits.set(key, { n: 1, until: t + this.windowMs })
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.until <= t) this.hits.delete(k)
      return true
    }
    h.n++
    return h.n <= this.max
  }
}
