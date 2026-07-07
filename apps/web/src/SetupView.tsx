import type { PodiumMode } from '@podium/core'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { makeTrpc, type Trpc } from './trpc'

// Intent-first labels: lead with what the user WANTS, not the deployment term. The pivot between
// the two "host" modes is simply whether your agents run on THIS machine (all-in-one) or on the
// other machines that connect to it (server/hub).
const MODES: { id: PodiumMode; title: string; blurb: string; needsServer: boolean }[] = [
  {
    id: 'all-in-one',
    title: 'Run Podium on this machine',
    blurb: 'The app and your agents both run here. Best if this is your only computer.',
    needsServer: false,
  },
  {
    id: 'server',
    title: 'Set up a hub for your other machines',
    blurb:
      'This box hosts the app; your agents run on the machines that connect to it — not here. Best for an always-on server or VPS.',
    needsServer: false,
  },
  {
    id: 'daemon',
    title: 'Add this machine to a Podium you already run',
    blurb: 'It runs agents here and connects to your existing server. Paste its join code.',
    needsServer: true,
  },
  {
    id: 'client',
    title: 'Just open a Podium running elsewhere',
    blurb: 'This machine only opens the app — it runs no agents. Enter the server’s URL.',
    needsServer: true,
  },
]

// Default relay port for the first-run reachability commands (config has no port yet).
const DEFAULT_PORT = 18787

// Derived from the tRPC client so the web bundle never imports @podium/core/setup.
type NetOption = Parameters<Trpc['setup']['commandFor']['query']>[0]['option']
type NetOptionInfo = Awaited<ReturnType<Trpc['setup']['options']['query']>>[number]

export function SetupView({
  httpOrigin,
  onSaved,
}: {
  httpOrigin: string
  onSaved: () => void
}): ReactNode {
  const trpc = useMemo(() => makeTrpc(httpOrigin), [httpOrigin])
  const [step, setStep] = useState<'mode' | 'network'>('mode')
  const [mode, setMode] = useState<PodiumMode>('all-in-one')
  const [serverUrl, setServerUrl] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // daemon joins with a one-paste code; client just needs the remote URL.
  const needsJoinCode = mode === 'daemon'
  const needsServerUrl = mode === 'client'

  const save = async (m: PodiumMode = mode): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (m === 'daemon') {
        // One pasted join code → daemon config, via the same core applyJoin the CLI uses.
        await trpc.setup.join.mutate({ code: joinCode.trim() })
      } else {
        // all-in-one ("skip reachability"), client (remote URL), server-only.
        await trpc.setup.connect.mutate({ mode: m, ...(m === 'client' ? { serverUrl } : {}) })
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'network') {
    // Reachability runs for BOTH host modes now (all-in-one and relay-only server), so a server
    // set up in the browser gets a publicUrl — matching the CLI and letting it mint join commands.
    const hostMode = mode === 'server' ? 'server' : 'all-in-one'
    return (
      <NetworkStep
        trpc={trpc}
        mode={hostMode}
        onBack={() => setStep('mode')}
        onSkip={() => void save(hostMode)}
        onSaved={onSaved}
      />
    )
  }

  return (
    <div className="setup-view mx-auto flex max-w-lg flex-col gap-4 p-6">
      <div>
        <h1 className="font-semibold text-foreground text-lg">Welcome to Podium</h1>
        <p className="text-[13px] text-muted-foreground">How should this install run?</p>
      </div>
      <fieldset className="flex flex-col gap-2">
        {MODES.map((m) => (
          <label
            key={m.id}
            htmlFor={`mode-${m.id}`}
            className="mode-option flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2"
          >
            <input
              type="radio"
              name="mode"
              value={m.id}
              id={`mode-${m.id}`}
              checked={mode === m.id}
              onChange={() => setMode(m.id)}
              className="mt-1"
            />
            <span className="flex flex-col">
              <strong className="text-[13px] text-foreground">{m.title}</strong>
              <span className="blurb text-[12px] text-muted-foreground">{m.blurb}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {needsServerUrl && (
        <div className="flex flex-col gap-1">
          <label htmlFor="server-url" className="text-[12px] text-muted-foreground">
            Server URL
          </label>
          <Input
            id="server-url"
            type="text"
            placeholder="ws://host:18787"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
        </div>
      )}
      {needsJoinCode && (
        <div className="flex flex-col gap-1">
          <label htmlFor="join-code" className="text-[12px] text-muted-foreground">
            Join code
          </label>
          <Input
            id="join-code"
            type="text"
            placeholder="paste the code from the server's Machines → Add machine"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            One code carries the server URL and pairing code.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      {mode === 'all-in-one' || mode === 'server' ? (
        // Both host modes go through the reachability step (URL + password).
        <Button type="button" onClick={() => setStep('network')}>
          Continue
        </Button>
      ) : (
        <Button
          type="button"
          disabled={
            busy || (needsJoinCode && !joinCode.trim()) || (needsServerUrl && !serverUrl.trim())
          }
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save & start'}
        </Button>
      )}
    </div>
  )
}

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
}: {
  trpc: Trpc
  onBack?: () => void
  onSkip?: () => void
  onSaved: () => void
  /** Compact layout (no page chrome / Back / Skip) for hosting inside a dialog. */
  embedded?: boolean
  /** Which host mode this box is; sent to setup.complete. Omitted (embedded) preserves it. */
  mode?: 'all-in-one' | 'server'
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

  useEffect(() => {
    trpc.setup.options
      .query()
      .then(setOptions)
      .catch(() => {})
  }, [trpc])
  useEffect(() => {
    trpc.setup.commandFor
      .query({ option, port: DEFAULT_PORT })
      .then(setCmd)
      .catch(() => {})
  }, [trpc, option])
  // If a login password is already set (e.g. setting the URL later from Settings → Machines),
  // default to keeping it rather than forcing the user to re-enter one.
  useEffect(() => {
    trpc.auth.status
      .query()
      .then((s) => {
        if (s.enabled) {
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
    try {
      await trpc.setup.complete.mutate({
        publicUrl: url,
        ...(mode ? { mode } : {}),
        // 'keep' sends neither field → the server leaves the existing password untouched.
        ...(authMode === 'password'
          ? { password: passwordValue }
          : authMode === 'open'
            ? { acknowledgeNoPassword: true }
            : {}),
      })
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
