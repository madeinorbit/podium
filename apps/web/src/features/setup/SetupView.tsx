import type { BootRelevantConfigField } from '@podium/model'
import type { PodiumMode } from '@podium/runtime'
// Browser-safe shared example used by the CLI prompt and telemetry preview too.
import { EXAMPLE_USAGE_REPORT_DISPLAY as TELEMETRY_EXAMPLE } from '@podium/telemetry/example'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { makeTrpc, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { navigateReload } from '@/lib/navigate'
import { NetworkStep, type SetupCompleteInput } from './network-step'

export { NetworkStep, quickTunnelWarning, reachablePort } from './network-step'

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

/** What each boot-relevant field is CALLED to an operator. The readiness route
 *  publishes config keys; a screen that repeated `persistence` at someone would be
 *  telling them the name of a variable, not what changed about their server. */
const STALE_FIELD_LABELS: Record<BootRelevantConfigField, string> = {
  mode: 'what this machine runs (all-in-one or server-only)',
  persistence: 'how Podium is kept running (its service setup)',
}

export function SetupView({
  httpOrigin,
  onSaved,
  localDefault = false,
  blockedState,
  staleFields,
  modeForcedByEnv,
}: {
  httpOrigin: string
  onSaved: () => void
  /** Trusted desktop/source launch: persist local all-in-one and continue to activation. */
  localDefault?: boolean
  /** Server-enforced blocked states that permit no setup mutation from this browser. */
  blockedState?: 'remote-setup' | 'restart-required'
  /** Which boot-relevant settings this process is stale on, from `/setup/config`
   *  (POD-2766). Empty or absent on an older server that does not publish them —
   *  the screen then says only that a restart is needed, as it always did. */
  staleFields?: readonly BootRelevantConfigField[]
  /**
   * The deployment set `PODIUM_MODE` (PDM-26), so the mode step is skipped.
   *
   * A dead control is worse here than anywhere else in the product: this is the
   * one screen a first-time operator has no context to interpret, and a
   * disabled row of mode buttons on it reads as "something is broken" rather
   * than "the deployment already answered". The remaining steps skip themselves
   * the same way through their own forced flags, so a fully env-configured
   * instance shows no wizard at all and the gate proceeds to login.
   */
  modeForcedByEnv?: boolean
}): ReactNode {
  const trpc = useMemo(() => makeTrpc(httpOrigin), [httpOrigin])
  const [step, setStep] = useState<'local' | 'mode' | 'network'>(
    modeForcedByEnv ? 'network' : localDefault ? 'local' : 'mode',
  )
  const [mode, setMode] = useState<PodiumMode>('all-in-one')
  const [serverUrl, setServerUrl] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // setup.join succeeded but flagged the server URL as an ephemeral quick tunnel — the
  // config IS applied; surface the warning (like the CLI does) before moving on.
  const [joinWarning, setJoinWarning] = useState<string | null>(null)
  /** "Restarting…" is not an error and not a success — the server drops the
   *  connection to comply, so this is a separate line from `error`. */
  const [activationNote, setActivationNote] = useState<string | null>(null)
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

  /**
   * Ask the server to replace its own process so it adopts the saved config.
   *
   * `setup.activate` is served while the data plane is blocked — that is the
   * point of the control plane — but it still needs an authenticated admin, so a
   * 401 here is not a failure to report as one: it means "log in first", and the
   * login screen in front of this gate can now succeed where it used to 503.
   *
   * The server goes away mid-flight by design. A rejected request is therefore
   * WEAK evidence of failure, so the note stays neutral and the poll in SetupGate
   * is what confirms recovery.
   */
  async function activateNow(): Promise<void> {
    setBusy(true)
    setError(null)
    setActivationNote(null)
    try {
      await trpc.setup.activate.mutate()
      setActivationNote('Restarting. This page reconnects on its own once Podium is back.')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(
        /unauthorized|forbidden|401|403/i.test(message)
          ? 'Sign in as an admin on this server to restart it.'
          : message,
      )
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
            Podium is running with the settings it started up with. A restart adopts what is saved.
            Nothing needs to be entered again.
          </p>
          {/* NAMING THE STALE SETTING (POD-2766). "Something changed, restart" is
              what an operator got before, and it left them unable to tell an
              intended change from one an unrelated call made by accident — which
              is exactly how this state was reached. */}
          {staleFields && staleFields.length > 0 ? (
            <p className="mt-2 text-[13px] text-muted-foreground">
              Waiting to take effect:{' '}
              {staleFields.map((field) => STALE_FIELD_LABELS[field]).join(', ')}.
            </p>
          ) : null}
        </div>
        {/* THE REMEDY, ON THE SAME SCREEN AS THE PROBLEM. The desktop shell
            restarts its own process; a browser talking to a server asks the
            server to restart itself through the control plane, which stays open
            while the data plane is blocked. The reload is the last resort for a
            server too old to offer either. */}
        {desktopRestart ? (
          <Button type="button" onClick={desktopRestart}>
            Restart Podium
          </Button>
        ) : (
          <Button type="button" disabled={busy} onClick={activateNow}>
            {busy ? 'Restarting…' : 'Restart Podium now'}
          </Button>
        )}
        {activationNote ? (
          <p className="text-[13px] text-muted-foreground">{activationNote}</p>
        ) : null}
        {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        <Button
          type="button"
          variant="outline"
          onClick={() => navigateReload('setup', 'setup-retry')}
        >
          Retry
        </Button>
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
        <Button
          type="button"
          variant="outline"
          onClick={() => navigateReload('setup', 'setup-retry')}
        >
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
        // No way back to a step that does not exist: under PODIUM_MODE the
        // deployment chose, and Back would land on a screen offering to unchoose.
        {...(modeForcedByEnv ? {} : { onBack: () => setStep('mode') })}
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
