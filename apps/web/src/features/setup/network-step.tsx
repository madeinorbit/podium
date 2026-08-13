import { type ReactNode, useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
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

/** Reachability step: pick how to expose the relay, run the printed command, paste the resulting
 *  https URL, then persist it via setup.complete. Used both by first-run setup (full page) and,
 *  with `embedded`, inside Settings → Machines when the server has no publicUrl yet. */
export function NetworkStep({
  trpc,
  onBack,
  onSkip,
  onSaved,
  embedded = false,
  mode,
  onCollected,
}: {
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
}): ReactNode {
  const [options, setOptions] = useState<NetOptionInfo[]>([])
  const [option, setOption] = useState<NetOption>('tailscale-funnel')
  const [cmd, setCmd] = useState<{ command: string; hint: string } | null>(null)
  const [url, setUrl] = useState('')
  // 'keep' = leave the already-set password untouched (only offered when one exists).
  const [authMode, setAuthMode] = useState<'password' | 'open' | 'keep'>('password')
  const [hasPassword, setHasPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [ackNoPassword, setAckNoPassword] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  // Ephemeral quick-tunnel flag for the pasted URL (mirrors the CLI's warning).
  const urlWarning = quickTunnelWarning(url)

  useEffect(() => {
    trpc.setup.options
      .query()
      .then(setOptions)
      .catch(() => {})
  }, [trpc])
  useEffect(() => {
    trpc.setup.commandFor
      .query({ option, port: reachablePort() })
      .then(setCmd)
      .catch(() => {})
  }, [trpc, option])
  // If a login password is already set (e.g. setting the URL later from Settings → Machines),
  // default to keeping it rather than forcing the user to re-enter one.
  useEffect(() => {
    trpc.auth.status
      .query()
      .then((s) => {
        // The CALLER's own credential — "a password is already set" is per-account now.
        if (s.hasOwnCredential) {
          setHasPassword(true)
          setAuthMode('keep')
        }
      })
      .catch(() => {})
  }, [trpc])

  const copy = (): void => {
    if (!cmd?.command) return
    void navigator.clipboard.writeText(cmd.command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const finish = async (): Promise<void> => {
    setErr('')
    const passwordValue = password.trim()
    if (authMode === 'password' && !passwordValue) {
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
      ...(mode ? { mode } : {}),
      // 'keep' sends neither field → the server leaves the existing password untouched.
      ...(authMode === 'password'
        ? { password: passwordValue }
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
              onChange={() => setOption(o.id)}
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
          Public URL
        </label>
        <Input
          id="public-url"
          type="text"
          placeholder="https://box.tailnet.ts.net"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
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
              onChange={(e) => setPassword(e.target.value)}
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
            onChange={() => setAuthMode('open')}
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
              onCheckedChange={(checked) => setAckNoPassword(checked === true)}
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
              (authMode === 'password'
                ? !password.trim()
                : authMode === 'open'
                  ? !ackNoPassword
                  : false)
            }
            onClick={() => void finish()}
          >
            {busy ? 'Saving…' : embedded ? 'Save URL' : 'Finish'}
          </Button>
        </div>
      </div>
    </div>
  )
}
