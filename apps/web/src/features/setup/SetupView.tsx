import type { PodiumMode } from '@podium/runtime'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { makeTrpc, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NetworkStep, type SetupCompleteInput } from './network-step'

export { NetworkStep, reachablePort, quickTunnelWarning } from './network-step'

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

type TelemetryChoice = NonNullable<SetupCompleteInput['telemetry']>

/**
 * Setup sub-step: telemetry [spec:SP-f933]. Host modes only (D10), and the LAST
 * question — everything before it is required for a working Podium; this is the
 * only optional one, so it must not be a tollbooth.
 *
 * Shows the same example report and the same four bullets as the CLI prompt,
 * with two switches, both defaulting OFF. A kill switch (DO_NOT_TRACK /
 * PODIUM_TELEMETRY=off) skips the step entirely rather than showing a dead
 * toggle: a box that has said "do not track" must not be asked about tracking.
 */
export function TelemetryStep({
  trpc,
  onBack,
  onFinish,
}: {
  trpc: Trpc
  onBack: () => void
  onFinish: (telemetry?: TelemetryChoice) => Promise<void>
}): ReactNode {
  const [usage, setUsage] = useState(false)
  const [crash, setCrash] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // undefined = still checking; null = ask normally; string = suppressed, skip.
  const [suppressed, setSuppressed] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    trpc.telemetry.state
      .query()
      .then((s) => {
        if (!cancelled) setSuppressed(s.suppressedBy ?? null)
      })
      // A failed probe must not strand the wizard — fall through to asking.
      .catch(() => {
        if (!cancelled) setSuppressed(null)
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  // Kill switch: commit the rest of the wizard with NO telemetry answer at all
  // (not even an explicit 'off' — we never asked, so we record nothing).
  useEffect(() => {
    if (suppressed) void onFinish(undefined)
  }, [suppressed, onFinish])

  const finish = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      await onFinish({ usage: usage ? 'on' : 'off', crash: crash ? 'on' : 'off' })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (suppressed === undefined || suppressed) {
    return <div className="setup-view mx-auto flex max-w-lg flex-col gap-4 p-6">Finishing…</div>
  }

  return (
    <div className="setup-view mx-auto flex max-w-lg flex-col gap-4 p-6">
      <div>
        <h1 className="font-semibold text-foreground text-lg">Anonymous telemetry (opt-in)</h1>
        <p className="text-[13px] text-muted-foreground">
          Nothing is collected unless you turn it on. One report a day, and this is exactly what it
          looks like:
        </p>
      </div>
      <pre className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1.5 text-[11px] leading-relaxed">
        {TELEMETRY_EXAMPLE}
      </pre>
      <ul className="flex flex-col gap-1 text-[12px] text-muted-foreground">
        <li>
          <strong className="text-foreground">Never</strong> paths, repo names, prompts, code, any
          free text
        </li>
        <li>
          <strong className="text-foreground">Your IP</strong> dropped at ingest, never reaches
          analytics
        </li>
        <li>
          <strong className="text-foreground">Opt out</strong> anytime in Settings → Privacy, or:{' '}
          <code>podium telemetry off</code>
        </li>
        <li>
          <strong className="text-foreground">Details</strong> <code>podium telemetry show</code> ·
          podium.dev/telemetry
        </li>
      </ul>
      <fieldset className="flex flex-col gap-2">
        <Label
          htmlFor="telemetry-usage"
          className="cursor-pointer items-start rounded-md border border-border px-3 py-2"
        >
          <Checkbox
            id="telemetry-usage"
            checked={usage}
            onCheckedChange={(c) => setUsage(c === true)}
          />
          <span className="text-[13px] text-foreground">Send anonymous usage reports</span>
        </Label>
        <Label
          htmlFor="telemetry-crash"
          className="cursor-pointer items-start rounded-md border border-border px-3 py-2"
        >
          <Checkbox
            id="telemetry-crash"
            checked={crash}
            onCheckedChange={(c) => setCrash(c === true)}
          />
          <span className="text-[13px] text-foreground">Send crash reports (scrubbed traces)</span>
        </Label>
      </fieldset>
      {err && (
        <p role="alert" className="text-[12px] text-destructive">
          {err}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          type="button"
          pending={busy}
          pendingLabel="Saving preferences…"
          onClick={() => void finish()}
        >
          {usage || crash ? 'Finish' : 'Finish without telemetry'}
        </Button>
      </div>
    </div>
  )
}

export function SetupView({
  httpOrigin,
  onSaved,
  localDefault = false,
  blockedState,
}: {
  httpOrigin: string
  onSaved: () => void
  /** Trusted desktop/source launch: persist local all-in-one and continue to activation. */
  localDefault?: boolean
  /** Server-enforced blocked states that permit no setup mutation from this browser. */
  blockedState?: 'remote-setup' | 'restart-required'
}): ReactNode {
  const trpc = useMemo(() => makeTrpc(httpOrigin), [httpOrigin])
  const [step, setStep] = useState<'local' | 'mode' | 'network'>(localDefault ? 'local' : 'mode')
  const [mode, setMode] = useState<PodiumMode>('all-in-one')
  const [serverUrl, setServerUrl] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // setup.join succeeded but flagged the server URL as an ephemeral quick tunnel — the
  // config IS applied; surface the warning (like the CLI does) before moving on.
  const [joinWarning, setJoinWarning] = useState<string | null>(null)
  // daemon joins with a one-paste code; client just needs the remote URL.
  const needsJoinCode = mode === 'daemon'
  const needsServerUrl = mode === 'client'
  const desktopRestart = (globalThis as { __PODIUM_RESTART__?: () => void }).__PODIUM_RESTART__

  useEffect(() => {
    if (step !== 'local') return
    let cancelled = false
    trpc.setup.connect
      .mutate({ mode: 'all-in-one' })
      .then(() => {
        if (!cancelled) onSaved()
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [step, trpc, onSaved])

  const save = async (m: PodiumMode = mode): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (m === 'daemon') {
        // One pasted join code → daemon config, via the same core applyJoin the CLI uses.
        const res = await trpc.setup.join.mutate({ code: joinCode.trim() })
        if (res?.warning) {
          // Joined, but to a rotating quick-tunnel URL: pause on the warning instead of
          // silently proceeding — the user should know this join will go stale.
          setJoinWarning(res.warning)
          return
        }
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

  if (blockedState === 'restart-required') {
    return (
      <div className="setup-view mx-auto flex max-w-lg flex-col gap-4 p-6">
        <div>
          <h1 className="font-semibold text-foreground text-lg">
            Setup is saved; Podium needs to restart
          </h1>
          <p className="text-[13px] text-muted-foreground">
            Restart Podium on the server so it can activate the new setup, then retry. No setup
            choices need to be entered again.
          </p>
        </div>
        {desktopRestart ? (
          <Button type="button" onClick={desktopRestart}>
            Restart Podium
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>
            Retry after restart
          </Button>
        )}
      </div>
    )
  }

  if (blockedState === 'remote-setup') {
    return (
      <div className="setup-view mx-auto flex max-w-lg flex-col gap-4 p-6">
        <div>
          <h1 className="font-semibold text-foreground text-lg">Finish setup on the server</h1>
          <p className="text-[13px] text-muted-foreground">
            This Podium is online, but setup must be completed from the machine that runs it. On
            that machine, run <code>podium setup</code>, finish access and login choices, then retry
            here.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    )
  }

  if (step === 'local') {
    return (
      <div className="setup-view mx-auto flex max-w-lg flex-col gap-4 p-6">
        <div>
          <h1 className="font-semibold text-foreground text-lg">Starting Podium on this machine</h1>
          <p className="text-[13px] text-muted-foreground">
            Setting up the local app and agent runtime…
          </p>
        </div>
        {error && (
          <>
            <p role="alert" className="text-[12px] text-destructive">
              {error}
            </p>
            <Button type="button" variant="outline" onClick={() => setStep('mode')}>
              Open advanced setup
            </Button>
          </>
        )}
      </div>
    )
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
      {joinWarning && (
        <div className="flex flex-col gap-2">
          <p
            role="alert"
            className="rounded-md border border-border px-3 py-2 text-[12px] text-amber-500"
          >
            {joinWarning}
          </p>
          <Button type="button" onClick={onSaved}>
            Continue anyway
          </Button>
        </div>
      )}
      {joinWarning ? null : mode === 'all-in-one' || mode === 'server' ? (
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
