import { useState, type FormEvent } from 'react'
import { signIn, useAuth } from '../data/auth.ts'
import { BTN, BTN_PRIMARY } from './DurabilityKit.tsx'

// Full-screen sign-in for a hosted server with accounts (server/accounts.ts). The world opens
// once the browser holds a session; locally this never shows.

export function SignIn() {
  const { signupOpen, busy, error } = useAuth()
  const [mode, setMode] = useState<'login' | 'signup'>(() => (signupOpen ? 'signup' : 'login'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void signIn(mode, email, password)
  }
  return (
    <div className="flex h-full items-center justify-center bg-void p-4">
      <form onSubmit={submit} className="hud-panel w-full max-w-sm p-6" aria-labelledby="wv-signin-title">
        <h1 id="wv-signin-title" className="hud-label m-0 mb-1 text-[11px] text-bone">
          Architectural Hyperspace
        </h1>
        <p className="m-0 mb-5 text-bone/70">{mode === 'signup' ? 'Make the account your world lives in.' : 'Sign in to open your world.'}</p>
        <label className="mb-3 block">
          <span className="hud-label mb-1 block">Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-bone/25 bg-void px-2 py-1.5 text-bone outline-none focus:border-ember"
          />
        </label>
        <label className="mb-4 block">
          <span className="hud-label mb-1 block">Password</span>
          <input
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'signup' ? 10 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-bone/25 bg-void px-2 py-1.5 text-bone outline-none focus:border-ember"
          />
          {mode === 'signup' && <span className="mt-1 block text-[11px] text-concrete">At least 10 characters.</span>}
        </label>
        {error && (
          <p role="alert" className="m-0 mb-3 text-signal">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button type="submit" className={BTN_PRIMARY} disabled={busy} aria-busy={busy}>
            {busy ? 'One moment…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </button>
          {signupOpen && (
            <button type="button" className={BTN} onClick={() => setMode((m) => (m === 'login' ? 'signup' : 'login'))}>
              {mode === 'login' ? 'New here?' : 'I have an account'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
