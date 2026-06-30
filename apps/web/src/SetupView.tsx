import type { PodiumMode } from '@podium/core'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { makeTrpc, type Trpc } from './trpc'

const MODES: { id: PodiumMode; title: string; blurb: string; needsServer: boolean }[] = [
  {
    id: 'all-in-one',
    title: 'All-in-one (this computer)',
    blurb: 'Run the server + agent daemon here.',
    needsServer: false,
  },
  {
    id: 'daemon',
    title: 'Daemon → external server',
    blurb: 'Contribute this machine to a server elsewhere.',
    needsServer: true,
  },
  {
    id: 'client',
    title: 'Client → external server',
    blurb: 'Just connect to a server running elsewhere.',
    needsServer: true,
  },
  {
    id: 'server',
    title: 'Server only',
    blurb: 'Run the relay here; daemons live elsewhere.',
    needsServer: false,
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
  const [pairCode, setPairCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needsServer = MODES.find((m) => m.id === mode)?.needsServer ?? false
  // Only daemon mode pairs a fresh machine; client mode just connects.
  const needsPair = mode === 'daemon'

  // POST the mode-only config (daemon/client/server, or "skip reachability" for all-in-one).
  const save = async (m: PodiumMode = mode): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const ns = MODES.find((x) => x.id === m)?.needsServer ?? false
      const body = ns
        ? m === 'daemon'
          ? { mode: m, serverUrl, pairCode }
          : { mode: m, serverUrl }
        : { mode: m }
      const res = await fetch(`${httpOrigin}/setup/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`setup failed (${res.status})`)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (step === 'network') {
    return (
      <NetworkStep
        trpc={trpc}
        onBack={() => setStep('mode')}
        onSkip={() => void save('all-in-one')}
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
      {needsServer && (
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
      {needsPair && (
        <div className="flex flex-col gap-1">
          <label htmlFor="pair-code" className="text-[12px] text-muted-foreground">
            Pairing code
          </label>
          <Input
            id="pair-code"
            type="text"
            placeholder="from the server's Machines settings"
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value)}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      {mode === 'all-in-one' ? (
        <Button type="button" onClick={() => setStep('network')}>
          Continue
        </Button>
      ) : (
        <Button type="button" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save & start'}
        </Button>
      )}
    </div>
  )
}

/** Reachability step for the all-in-one (main-instance) path: pick how to expose the relay,
 *  run the printed command, paste the resulting https URL, then persist it via setup.complete. */
function NetworkStep({
  trpc,
  onBack,
  onSkip,
  onSaved,
}: {
  trpc: Trpc
  onBack: () => void
  onSkip: () => void
  onSaved: () => void
}): ReactNode {
  const [options, setOptions] = useState<NetOptionInfo[]>([])
  const [option, setOption] = useState<NetOption>('tailscale-funnel')
  const [cmd, setCmd] = useState<{ command: string; hint: string } | null>(null)
  const [url, setUrl] = useState('')
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

  const copy = (): void => {
    if (!cmd?.command) return
    void navigator.clipboard.writeText(cmd.command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const finish = async (): Promise<void> => {
    setErr('')
    setBusy(true)
    try {
      await trpc.setup.complete.mutate({ publicUrl: url })
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup-view mx-auto flex max-w-lg flex-col gap-4 p-6">
      <div>
        <h1 className="font-semibold text-foreground text-lg">Make this instance reachable</h1>
        <p className="text-[13px] text-muted-foreground">
          Choose how to expose this Podium so your other devices can connect, run the command, then
          paste the URL it prints.
        </p>
      </div>
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
      {err && (
        <p role="alert" className="text-[12px] text-destructive">
          {err}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onSkip}>
            Skip for now
          </Button>
          <Button type="button" disabled={busy || !url} onClick={() => void finish()}>
            {busy ? 'Saving…' : 'Finish'}
          </Button>
        </div>
      </div>
    </div>
  )
}
