import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { serverConfig } from '@/app/trpc'
import { setTextIfChanged, startAsciiAnimation } from '@/lib/ascii-animation'
import { ASCII_COVERAGE } from './podium-ascii'

type GatePhase = 'loading' | 'login' | 'success' | 'reveal' | 'ready'

/* Fixed dark-screen tokens from the login spec (Podium Login 2b Handoff) — the login
   screen is intentionally theme-independent. */
const C = {
  bg: '#0a0a0e',
  bar: '#0e0e12',
  border: '#3a3a46',
  accent: '#D97757',
  accentText: '#2b1208',
  success: '#10b981',
  error: '#f43f5e',
  errorText: '#f87171',
  amber: '#f59e0b',
  text: '#f3f3f8',
  textDim: '#9a9aa8',
  textFaint: '#7a7a86',
} as const

const GLOW = {
  idle: 'rgba(217,119,87,.08)',
  busy: 'rgba(16,185,129,.09)',
  error: 'rgba(244,63,94,.11)',
  success: 'rgba(16,185,129,.13)',
} as const

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const MONO = "'Geist Mono Variable', ui-monospace, Menlo, monospace"

/**
 * Ask the server whether a login is needed. Returns 'login' only when a password is set AND
 * this client isn't authed yet. A non-OK response or an unreachable/garbled backend resolves
 * to 'ready' so we never block the app on auth — a backend without the route can't need it,
 * and SetupGate owns the genuine "unreachable" UX (this gate sits outside it).
 */
async function probeAuth(httpOrigin: string): Promise<'login' | 'ready'> {
  const res = await fetch(`${httpOrigin}/auth/status`, { credentials: 'include' })
  if (!res.ok) return 'ready'
  let data: { needsAuth?: unknown; authed?: unknown }
  try {
    data = (await res.json()) as { needsAuth?: unknown; authed?: unknown }
  } catch {
    return 'ready'
  }
  return data.needsAuth === true && data.authed !== true ? 'login' : 'ready'
}

/** The host you're signing in to, shown for reassurance on a self-hosted install. */
function originHost(httpOrigin: string): string {
  try {
    return new URL(httpOrigin).host
  } catch {
    return ''
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/* ── ASCII wordmark ─────────────────────────────────────────────────────────
   The PODIUM wordmark ships as a precomputed 96×22 coverage grid (one hex
   nibble per cell — see scripts/generate-login-ascii.ts). Rendering maps
   coverage onto a density ramp; the idle shimmer only remaps characters. */

const RAMP = ' .`\'^",:;!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$'

/** One frame of the wordmark. `t` is seconds for the shimmer; null renders it static. */
function asciiFrame(t: number | null): string {
  const n = RAMP.length - 1
  let out = ''
  for (const [y, line] of ASCII_COVERAGE.entries()) {
    for (let x = 0; x < line.length; x++) {
      const v = parseInt(line.charAt(x), 16)
      if (v === 0) {
        out += ' '
        continue
      }
      const cov = v / 15
      const b = t === null ? cov : cov * (0.8 + 0.2 * Math.sin(x * 0.22 + y * 0.13 - t * 2.2))
      out += RAMP.charAt(Math.min(n, Math.max(1, Math.round(b * n))))
    }
    out += '\n'
  }
  return out
}

function AsciiWordmark({ color }: { color: string }): ReactNode {
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const pre = preRef.current
    if (!pre) return
    return startAsciiAnimation({
      renderStatic: () => asciiFrame(null),
      renderFrame: asciiFrame,
      commit: (frame) => {
        if (preRef.current) setTextIfChanged(preRef.current, frame)
      },
      reducedMotion: prefersReducedMotion(),
    })
  }, [])

  return (
    <pre
      ref={preRef}
      role="img"
      aria-label="Podium"
      style={{
        margin: 0,
        minHeight: 143,
        fontFamily: "Menlo, Consolas, 'Courier New', monospace",
        fontSize: '6.5px',
        lineHeight: 1,
        letterSpacing: 0,
        whiteSpace: 'pre',
        userSelect: 'none',
        color,
        transition: 'color .5s',
      }}
    />
  )
}

/* ── Login view ───────────────────────────────────────────────────────────── */

type LoginState = 'empty' | 'typing' | 'busy' | 'error' | 'ok'

/**
 * Full-viewport password screen (fused bar, spec 2b). On a 200 the session cookie is set
 * and `onLoggedIn` fires immediately; `leaving` then fades the layer out over the app.
 */
export function LoginView({
  httpOrigin,
  onLoggedIn,
  leaving = false,
}: {
  httpOrigin: string
  onLoggedIn: () => void
  leaving?: boolean
}): ReactNode {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shaking, setShaking] = useState(false)
  const [caps, setCaps] = useState(false)
  const [spinFrame, setSpinFrame] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the field on mount (login is the only thing on screen), lint-cleanly (no autoFocus).
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Braille spinner in the submit button while verifying: 80ms per frame.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setSpinFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(id)
  }, [busy])

  const submit = async (): Promise<void> => {
    if (!password || busy || ok) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${httpOrigin}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        setBusy(false)
        setOk(true)
        onLoggedIn()
        return
      }
      setError(
        res.status === 429
          ? '✗ too many attempts — wait a moment, then try again'
          : '✗ incorrect password — try again',
      )
      setShaking(true)
    } catch {
      setError("✗ couldn't reach the server")
      setShaking(true)
    } finally {
      setBusy(false)
    }
  }

  const trackCaps = (e: ReactKeyboardEvent): void => {
    const on = typeof e.getModifierState === 'function' && e.getModifierState('CapsLock')
    setCaps(on)
  }

  const state: LoginState = ok
    ? 'ok'
    : busy
      ? 'busy'
      : error
        ? 'error'
        : password
          ? 'typing'
          : 'empty'

  const glow =
    state === 'ok'
      ? GLOW.success
      : state === 'error'
        ? GLOW.error
        : state === 'busy'
          ? GLOW.busy
          : GLOW.idle
  const statColor =
    state === 'ok'
      ? C.success
      : state === 'error'
        ? C.errorText
        : state === 'busy'
          ? '#34d399'
          : state === 'typing'
            ? C.textDim
            : C.amber
  const statText =
    state === 'ok'
      ? '✓ signed in — welcome back'
      : state === 'error'
        ? error
        : state === 'busy'
          ? 'verifying…'
          : state === 'typing'
            ? 'press ⏎ to sign in'
            : 'waiting on you — enter your password'
  const btnGlyph = state === 'busy' ? SPINNER_FRAMES[spinFrame] : state === 'ok' ? '✓' : '→'

  const host = originHost(httpOrigin)
  const reduced = prefersReducedMotion()

  return (
    <div
      className="podium-login"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        boxSizing: 'border-box',
        padding: 24,
        fontFamily: "'Geist Variable', sans-serif",
        color: '#d7d7e0',
        background: `radial-gradient(460px 280px at 50% 32%, ${glow}, transparent 72%), ${C.bg}`,
        transition: reduced ? 'opacity .2s ease' : 'background .5s, opacity .6s ease',
        opacity: leaving ? 0 : 1,
        pointerEvents: leaving ? 'none' : 'auto',
      }}
    >
      <style>{`
        .podium-login input::placeholder{color:#5a5a66}
        @keyframes podium-login-shake{0%,100%{transform:none}20%{transform:translateX(-6px)}40%{transform:translateX(5px)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
        @keyframes podium-login-ping{0%{box-shadow:0 0 0 0 rgba(16,185,129,.55)}70%{box-shadow:0 0 0 8px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}
        @keyframes podium-login-pop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.18);opacity:1}100%{transform:scale(1)}}
        @media (prefers-reduced-motion: reduce){.podium-login *{animation:none !important}}
      `}</style>

      <AsciiWordmark color={ok ? C.success : C.text} />

      <div
        style={{
          fontFamily: MONO,
          fontSize: 9,
          letterSpacing: '.16em',
          color: C.textFaint,
          textTransform: 'uppercase',
        }}
      >
        {host ? `Sign in to ${host}` : 'Sign in'}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onAnimationEnd={() => setShaking(false)}
        style={{
          width: '100%',
          maxWidth: 520,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          border: `1px solid ${error ? C.error : C.border}`,
          borderRadius: 13,
          background: C.bar,
          padding: '6px 6px 6px 18px',
          boxShadow: error ? `0 0 0 1px ${C.error}33, 0 0 18px ${C.error}26` : 'none',
          animation: shaking ? 'podium-login-shake .35s ease' : 'none',
          transition: 'border-color .25s, box-shadow .25s',
        }}
      >
        <input
          ref={inputRef}
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="current-password"
          spellCheck={false}
          value={password}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setPassword(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={trackCaps}
          onKeyUp={trackCaps}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 0,
            outline: 'none',
            fontFamily: MONO,
            fontSize: 16,
            letterSpacing: '.06em',
            color: C.text,
            caretColor: C.accent,
          }}
        />
        <button
          type="submit"
          aria-label="Log in"
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 42,
            height: 42,
            border: 0,
            borderRadius: 9,
            background: ok ? C.success : C.accent,
            color: C.accentText,
            fontFamily: MONO,
            fontSize: 16,
            fontWeight: 600,
            cursor: 'pointer',
            opacity: (password && !busy) || ok ? 1 : 0.45,
            transition: 'opacity .3s, background .4s',
          }}
        >
          {btnGlyph}
        </button>
      </form>

      <div
        role={error ? 'alert' : 'status'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          minHeight: 20,
          fontFamily: MONO,
          fontSize: 11,
          color: statColor,
          transition: 'color .4s',
        }}
      >
        {state !== 'busy' && (
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 99,
              background: statColor,
              animation: ok ? 'podium-login-ping 1.2s ease infinite' : 'none',
              transition: 'background .4s',
            }}
          />
        )}
        {statText}
        {caps && !ok && (
          <span
            style={{
              fontSize: 9,
              letterSpacing: '.08em',
              color: '#161006',
              background: C.amber,
              borderRadius: 99,
              padding: '2px 8px',
              animation: 'podium-login-pop .3s ease',
            }}
          >
            ⇪ CAPS LOCK ON
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Gates the app on the human-client login. Open mode (no password) and already-authed both
 * pass straight through; otherwise the password screen is shown. Deliberately separate from
 * SetupGate so the two concerns (which deployment mode vs. who are you) stay decoupled —
 * wrap it OUTSIDE SetupGate: authenticate to the server first, then resolve setup state.
 *
 * Success choreography (spec 2b §5): the app mounts BEHIND the opaque login layer the moment
 * auth succeeds — its first tRPC/WS connections are established then, carrying the fresh
 * session cookie, so no reload is needed. t=0 success beat → t=900ms the login layer fades
 * while the shell un-blurs → t=1500ms the login layer unmounts.
 */
export function LoginGate({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<GatePhase>('loading')
  const httpOrigin = serverConfig(window.location).httpOrigin

  useEffect(() => {
    let alive = true
    probeAuth(httpOrigin)
      .then((p) => {
        if (alive) setPhase(p)
      })
      .catch(() => {
        if (alive) setPhase('ready')
      })
    return () => {
      alive = false
    }
  }, [httpOrigin])

  useEffect(() => {
    if (phase === 'success') {
      const id = setTimeout(() => setPhase('reveal'), 900)
      return () => clearTimeout(id)
    }
    if (phase === 'reveal') {
      const id = setTimeout(() => setPhase('ready'), prefersReducedMotion() ? 250 : 600)
      return () => clearTimeout(id)
    }
  }, [phase])

  if (phase === 'loading') return null
  if (phase === 'ready') return <>{children}</>

  const reduced = prefersReducedMotion()
  const appMounted = phase === 'success' || phase === 'reveal'
  const blurred = phase === 'success' && !reduced
  return (
    <>
      {appMounted && (
        <div
          style={{
            height: '100%',
            filter: blurred ? 'blur(3px) saturate(.5) brightness(.6)' : 'none',
            transform: blurred ? 'scale(.985)' : 'scale(1)',
            transition: reduced ? 'none' : 'filter .6s ease, transform .6s ease',
          }}
        >
          {children}
        </div>
      )}
      <LoginView
        httpOrigin={httpOrigin}
        leaving={phase === 'reveal'}
        onLoggedIn={() => setPhase('success')}
      />
    </>
  )
}
