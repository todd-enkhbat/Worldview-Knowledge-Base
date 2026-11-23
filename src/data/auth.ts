import { create } from 'zustand'
import { CLIENT_ID } from './serverSync.ts'

// Signing in to a hosted server (server/accounts.ts). A server started with
// HYPERSPACE_ACCOUNTS=1 answers /api/health with auth 'required' until this browser holds a
// session cookie; the world opens only after sign-in. Locally (auth 'none') none of this runs.

export interface AuthUser {
  id: string
  email: string
}

export interface AuthState {
  /** 'none': no accounts on this server. */
  state: 'unknown' | 'none' | 'signed-out' | 'signed-in'
  user: AuthUser | null
  /** Whether this server lets a new account sign up. */
  signupOpen: boolean
  error: string | null
  busy: boolean
}

export const useAuth = create<AuthState>()(() => ({ state: 'unknown', user: null, signupOpen: false, error: null, busy: false }))

const waiters: (() => void)[] = []

/** Resolves once the browser is signed in (immediately when it already is). */
export function signedIn(): Promise<void> {
  if (useAuth.getState().state === 'signed-in') return Promise.resolve()
  return new Promise((r) => waiters.push(r))
}

/** Learn whether this server needs sign-in and who is signed in. */
export async function checkAuth(auth: 'none' | 'required' | 'signed-in', f: typeof fetch = fetch): Promise<AuthState['state']> {
  if (auth === 'none') {
    useAuth.setState({ state: 'none' })
    return 'none'
  }
  const me = (await (await f('/api/auth/me')).json()) as { user: AuthUser | null; signup: boolean }
  const state = me.user ? 'signed-in' : 'signed-out'
  useAuth.setState({ state, user: me.user, signupOpen: me.signup })
  if (state === 'signed-in') waiters.splice(0).forEach((r) => r())
  return state
}

async function post(path: string, body: unknown, f: typeof fetch): Promise<{ user?: AuthUser; error?: string }> {
  const res = await f(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wv-client': CLIENT_ID },
    body: JSON.stringify(body),
  })
  const out = (await res.json().catch(() => ({}))) as { user?: AuthUser; error?: string }
  if (!res.ok) throw new Error(out.error ?? `${res.status} ${res.statusText}`)
  return out
}

/** Sign in (or sign up) and let the waiting boot open the world. */
export async function signIn(mode: 'login' | 'signup', email: string, password: string, f: typeof fetch = fetch): Promise<boolean> {
  useAuth.setState({ busy: true, error: null })
  try {
    const { user } = await post(mode, { email, password }, f)
    useAuth.setState({ state: 'signed-in', user: user ?? null, busy: false })
    waiters.splice(0).forEach((r) => r())
    return true
  } catch (e) {
    useAuth.setState({ busy: false, error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

/** Sign out and reload (the world in memory belongs to the account). */
export async function signOut(f: typeof fetch = fetch): Promise<void> {
  await post('logout', {}, f).catch(() => {})
  location.reload()
}
