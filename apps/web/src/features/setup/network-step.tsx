import { type ReactNode, useEffect, useState } from 'react'
import { serverConfig, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Fallback relay port for the first-run reachability commands, used ONLY when the location
// carries no explicit port (an https reverse-proxied origin on 443, where naming 443 would be
// wrong too). The config has no port yet, but the browser does: this page is served BY the
// instance it is configuring, so its own location names the port to expose.
const DEFAULT_PORT = 18787

/**
 * The port the reachability command must name. Read from the document's own location — the
 * instance serving this page IS the instance being made reachable, so `tailscale funnel <port>`
 * has to name the port it actually listens on, not the default (POD-1583).
 */
export function reachablePort(loc: { port?: string } = window.location): number {
  const port = Number(loc.port)
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT
}

/**
 * Warn when a URL is a Cloudflare QUICK tunnel (*.trycloudflare.com): those URLs rotate on
 * every cloudflared restart, so every joined machine goes dark until it is re-pointed.
 * Mirrors @podium/runtime/setup's ephemeralTunnelWarning — duplicated (tiny, pure) because the
 * web bundle must not import @podium/runtime/setup (it pulls node:fs via ./config).
 */
export function quickTunnelWarning(url: string): string | undefined {
  let host: string
  try {
    host = new URL(url.trim()).hostname
  } catch {
    return undefined
  }
  if (host === 'trycloudflare.com' || host.endsWith('.trycloudflare.com')) {
    return (
      'This is a Cloudflare QUICK tunnel URL — it changes every time cloudflared restarts, ' +
      'and every joined machine will lose contact until it is pointed at the new URL. ' +
      'Fine for a demo; use Tailscale or a named tunnel for anything durable.'
    )
  }
  return undefined
}

// Derived from the tRPC client so the web bundle never imports @podium/runtime/setup.
type NetOption = Parameters<Trpc['setup']['commandFor']['query']>[0]['option']
type NetOptionInfo = Awaited<ReturnType<Trpc['setup']['options']['query']>>[number]
/** The whole-wizard commit payload, derived from the router so it can't drift. */
export type SetupCompleteInput = Parameters<Trpc['setup']['complete']['mutate']>[0]

/** What the form starts from: the state this instance is ALREADY in, resolved before a
 *  single field is rendered. See `networkStepInitialState`. */
export interface NetworkStepInitialState {
  /** The saved reachable URL, seeded into the input. Empty when there is none. */
  url: string
  /** Which saved exposure option to preselect, or `null` for an older unclassified URL. */
  option: NetOption | null
  /** Does the CALLER already have a credential — i.e. is "keep current password" offered. */
  hasPassword: boolean
}

/**
 * SEED THE FORM FROM THE INSTANCE, don't open it blank (POD-1148).
 *
 * `Change…` used to render an empty URL box and a preselected radio however the instance was
 * actually configured, so the one thing the server does remember (`publicUrl`) was thrown away
 * and the one thing it does NOT remember (the tunnel option) was displayed as if it did.
 *
 * Older configs can have a URL without a saved option. Keep those unselected rather than
 * guessing from the hostname; every new save records the explicit choice.
 */
export function networkStepInitialState(
  info: { publicUrl: string | null; networkOption?: NetOption | null } | null,
  status: { hasOwnCredential: boolean } | null,
): NetworkStepInitialState {
  const url = info?.publicUrl ?? ''
  return {
    url,
    option: info?.networkOption ?? (url ? null : 'tailscale-funnel'),
    hasPassword: Boolean(status?.hasOwnCredential),
  }
}

interface NetworkStepProps {
  trpc: Trpc
  onBack?: () => void
  onSkip?: () => void
  onSaved: () => void
  /** Compact layout (no page chrome / Back / Skip) for hosting inside a dialog. */
  embedded?: boolean
  /** Which host mode this box is; sent to setup.complete. Omitted (embedded) preserves it. */
  mode?: 'all-in-one' | 'server'
  /** When set, this step does NOT commit: it hands the collected payload up so a
   *  later sub-step (telemetry) can commit the whole wizard in one call
   *  [spec:SP-f933]. Absent = commit immediately (the embedded Settings use). */
  onCollected?: (payload: SetupCompleteInput) => void
}

/** Reachability step: pick how to expose the relay, run the printed command, paste the resulting
 *  https URL, then persist it via setup.complete. Used both by first-run setup (full page) and,
 *  with `embedded`, inside Settings → Machines when the server has no publicUrl yet.
 *
 *  NOTHING IS RENDERED UNTIL THE CURRENT CONFIG IS KNOWN, and the split into a loader plus an
 *  inner form is what buys that: every field below is a `useState` INITIALISER over the resolved
 *  answer, so no query can land later and overwrite what the user has already typed. It used to
 *  render immediately with `authMode` guessed as 'password'; a password typed into that box was
 *  silently dropped the moment `auth.status` resolved and flipped the mode to 'keep' (POD-1148). */
export function NetworkStep(props: NetworkStepProps): ReactNode {
  const { trpc, embedded = false } = props
  const [initial, setInitial] = useState<NetworkStepInitialState | null>(null)

  useEffect(() => {
    let live = true
    // Both reads are ADVISORY: a server that cannot answer either still gets a usable blank
    // form, which is what this step did unconditionally before it seeded anything. `optional`
    // is an async wrapper rather than a bare `.catch` so a synchronously-throwing client (a
    // stub without `setup.info`) degrades the same way a rejection does, instead of killing
    // the effect and leaving the step stuck on "Loading…".
    const optional = async <T,>(read: () => Promise<T>): Promise<T | null> => {
      try {
        return await read()
      } catch {
        return null
      }
    }
    void Promise.all([
      optional(() => trpc.setup.info.query()),
      optional(() => trpc.auth.status.query()),
    ]).then(([info, status]) => {
      if (live) setInitial(networkStepInitialState(info, status))
    })
    return () => {
      live = false
    }
  }, [trpc])

  if (!initial) {
    return (
      <div className={embedded ? 'setup-view' : 'setup-view mx-auto max-w-lg p-6'}>
        <p className="text-[13px] text-muted-foreground">Loading…</p>
      </div>
    )
  }
  return <NetworkStepForm {...props} initial={initial} />
}

function NetworkStepForm({
  trpc,
  onBack,
  onSkip,
  onSaved,
  embedded = false,
  mode,
  onCollected,
  initial,
}: NetworkStepProps & { initial: NetworkStepInitialState }): ReactNode {
  const httpOrigin = serverConfig(window.location).httpOrigin
  const [options, setOptions] = useState<NetOptionInfo[]>([])
  const [option, setOption] = useState<NetOption | null>(initial.option)
  const [cmd, setCmd] = useState<{ command: string; hint: string } | null>(null)
  const [url, setUrl] = useState(initial.url)
  // 'keep' = leave the already-set password untouched (only offered when one exists), and it is
  // the default whenever the caller HAS one — re-entering a password to change a URL is not the
  // ask. The credential is known before this component mounts, so this is never a guess.
  const [authMode, setAuthMode] = useState<'password' | 'open' | 'keep'>(
    initial.hasPassword ? 'keep' : 'password',
  )
  const [password, setPassword] = useState('')
  const [ackNoPassword, setAckNoPassword] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const hasPassword = initial.hasPassword
  // Ephemeral quick-tunnel flag for the pasted URL (mirrors the CLI's warning).
  const urlWarning = quickTunnelWarning(url)

  useEffect(() => {
    trpc.setup.options
      .query()
      .then(setOptions)
      .catch(() => {})
  }, [trpc])
  useEffect(() => {
    if (option === null) {
      setCmd(null)
      return
    }
    trpc.setup.commandFor
      .query({ option, port: reachablePort() })
      .then(setCmd)
      .catch(() => {})
  }, [trpc, option])

  const copy = (): void => {
    if (!cmd?.command) return
    void navigator.clipboard.writeText(cmd.command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const finish = async (): Promise<void> => {
    setErr('')
    // NOT `password.trim()` (POD-1148). The login route verifies the raw string and
    // `auth.setPassword` hashes the raw string, so trimming here stored a credential the user
    // could never type again — and made Settings → Security and Settings → Network disagree
    // about what identical keystrokes mean. Empty is still empty; whitespace is a character.
    if (authMode === 'password' && !password) {
      setErr('Enter a login password or choose no-password mode.')
      return
    }
    if (authMode === 'open' && !ackNoPassword) {
      setErr('Confirm running without a login password.')
      return
    }
    setBusy(true)
    const payload: SetupCompleteInput = {
      publicUrl: url,
      ...(option ? { networkOption: option } : {}),
      ...(mode ? { mode } : {}),
      // 'keep' sends neither field → the server leaves the existing password untouched.
      ...(authMode === 'password'
        ? { password }
        : authMode === 'open'
          ? { acknowledgeNoPassword: true }
          : {}),
    }
    // Deferred commit: hand the payload to the telemetry sub-step, which sends
    // ONE setup.complete for the whole wizard. Nothing is written yet.
    if (onCollected) {
      setBusy(false)
      onCollected(payload)
      return
    }
    try {
      await trpc.setup.complete.mutate(payload)
      // A PASSWORD LOCKS THIS DEVICE OUT OF THE WRITE IT JUST MADE (POD-1148). `complete`
      // stores the password last; the instant it lands `credentialsRequired()` goes true and
      // the open-mode synthetic-admin fallback stops applying, so the very next request —
      // `onSaved()` → the caller's reload → setup.info — 401s, and the URL write that already
      // committed is reported to the user as a failure. Take the cookie the guard now wants,
      // exactly as Settings → Security does after `auth.setPassword`. Unchecked on purpose:
      // a login hiccup must not turn a write that SUCCEEDED into an error message.
      if (payload.password !== undefined) {
        await fetch(`${httpOrigin}/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ password: payload.password }),
        }).catch(() => {})
      }
      setSaved(true)
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={
        embedded
          ? // min-w-0: embedded in a CSS-grid dialog, whose items won't shrink below content
            // width — a long tunnel command would otherwise push the popup out.
            'setup-view flex min-w-0 flex-col gap-4'
          : 'setup-view mx-auto flex max-w-lg flex-col gap-4 p-6'
      }
    >
      {!embedded && (
        <div>
          <h1 className="font-semibold text-foreground text-lg">Make this instance reachable</h1>
          <p className="text-[13px] text-muted-foreground">
            Choose how to expose this Podium so your other devices can connect, run the command,
            then paste the URL it prints.
          </p>
        </div>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-[12px] text-muted-foreground">How to expose this instance</legend>
        {initial.option === null && (
          <p className="text-[12px] text-muted-foreground">
            Choose how this URL is exposed. Podium will save the selection with the URL.
          </p>
        )}
        {options.map((o) => (
          <label
            key={o.id}
            htmlFor={`net-${o.id}`}
            className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2"
          >
            <input
              type="radio"
              name="net-option"
              value={o.id}
              id={`net-${o.id}`}
              checked={option === o.id}
              onChange={() => {
                setOption(o.id)
                setSaved(false)
              }}
              className="mt-1"
            />
            <span className="flex flex-col">
              <strong className="text-[13px] text-foreground">{o.label}</strong>
              <span className="text-[12px] text-muted-foreground">{o.note}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {cmd?.command ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
            Run this command
          </span>
          <div className="flex items-start gap-2">
            <code className="flex-1 break-all rounded bg-muted px-2 py-1.5 text-[12px] leading-relaxed">
              {cmd.command}
            </code>
            <Button type="button" variant="outline" size="sm" className="flex-none" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}
      {cmd?.hint ? <p className="text-[12px] text-muted-foreground">{cmd.hint}</p> : null}
      <div className="flex flex-col gap-1">
        <label htmlFor="public-url" className="text-[12px] text-muted-foreground">
          Podium URL
        </label>
        <Input
          id="public-url"
          type="text"
          placeholder="https://box.tailnet.ts.net"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setSaved(false)
          }}
        />
        {/* Same *.trycloudflare.com flag the CLI setup shows — warn, never block. */}
        {urlWarning && (
          <p role="alert" className="text-[12px] text-amber-500">
            {urlWarning}
          </p>
        )}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-[12px] text-muted-foreground">Login</legend>
        {hasPassword && (
          <label
            htmlFor="setup-auth-keep"
            className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2"
          >
            <input
              id="setup-auth-keep"
              type="radio"
              name="setup-auth"
              value="keep"
              checked={authMode === 'keep'}
              onChange={() => {
                setAuthMode('keep')
                setAckNoPassword(false)
                setSaved(false)
              }}
              className="mt-1"
            />
            <span className="flex flex-col">
              <strong className="text-[13px] text-foreground">Keep current password</strong>
              <span className="text-[12px] text-muted-foreground">
                A login password is already set — leave it unchanged.
              </span>
            </span>
          </label>
        )}
        <label
          htmlFor="setup-auth-password"
          className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2"
        >
          <input
            id="setup-auth-password"
            type="radio"
            name="setup-auth"
            value="password"
            checked={authMode === 'password'}
            onChange={() => {
              setAuthMode('password')
              setAckNoPassword(false)
              setSaved(false)
            }}
            className="mt-1"
          />
          <span className="flex flex-col">
            <strong className="text-[13px] text-foreground">
              {hasPassword ? 'Change the login password' : 'Require a login password'}
            </strong>
            <span className="text-[12px] text-muted-foreground">
              Recommended for reachable instances.
            </span>
          </span>
        </label>
        {authMode === 'password' && (
          <div className="ml-6 flex flex-col gap-1">
            <label htmlFor="setup-password" className="text-[12px] text-muted-foreground">
              Login password
            </label>
            <Input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              placeholder="Password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setSaved(false)
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Devices will need this password to connect.
            </p>
          </div>
        )}
        <label
          htmlFor="setup-auth-open"
          className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2"
        >
          <input
            id="setup-auth-open"
            type="radio"
            name="setup-auth"
            value="open"
            checked={authMode === 'open'}
            onChange={() => {
              setAuthMode('open')
              setSaved(false)
            }}
            className="mt-1"
          />
          <span className="flex flex-col">
            <strong className="text-[13px] text-foreground">Run without a Podium password</strong>
            <span className="text-[12px] text-muted-foreground">
              Use only when access is already restricted, for example by your private network.
            </span>
          </span>
        </label>
        {authMode === 'open' && (
          <Label className="ml-6 cursor-pointer items-start rounded-md border border-border px-3 py-2 text-[12px] text-muted-foreground">
            <Checkbox
              checked={ackNoPassword}
              onCheckedChange={(checked) => {
                setAckNoPassword(checked === true)
                setSaved(false)
              }}
            />
            <span>
              I understand that anyone who can reach this Podium URL can control agents and shells.
            </span>
          </Label>
        )}
      </fieldset>
      {err && (
        <p role="alert" className="text-[12px] text-destructive">
          {err}
        </p>
      )}
      <p role="status" className="min-h-4 text-[12px] text-success">
        {saved ? 'Network settings saved.' : ''}
      </p>
      <div className="flex items-center justify-between gap-2">
        {onBack ? (
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {onSkip && (
            <Button type="button" variant="outline" size="sm" onClick={onSkip}>
              Skip for now
            </Button>
          )}
          <Button
            type="button"
            disabled={
              busy ||
              !url.trim() ||
              (authMode === 'password' ? !password : authMode === 'open' ? !ackNoPassword : false)
            }
            onClick={() => void finish()}
          >
            {busy ? 'Saving…' : embedded ? 'Save network settings' : 'Finish'}
          </Button>
        </div>
      </div>
    </div>
  )
}
