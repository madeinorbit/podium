/**
 * Settings → Privacy [spec:SP-f933] — the web half of `podium telemetry`.
 *
 * SELF-PERSISTING (like Security/Updates/Network), not a blob-editing section:
 * telemetry consent lives in config.json (D8), not the settings blob, so each
 * toggle lands immediately through `telemetry.set`. "I turned telemetry off"
 * must never be lost to an unsaved page — the one setting where forgetting to
 * press Save would be a betrayal rather than an inconvenience.
 *
 * A tier disabled by DO_NOT_TRACK / PODIUM_TELEMETRY=off renders disabled WITH
 * the reason, mirroring how experimental.tsx renders config-locked flags: a
 * toggle that silently refuses to move is a bug report waiting to happen.
 */
// The example report — literally the same string the CLI prompt and setup
// wizard show, not a copy. It WAS a copy, and had already drifted. The
// `/example` subpath is the one browser-safe entry (zero runtime imports);
// the bare `@podium/telemetry` specifier pulls the emitter and node:fs.
import { EXAMPLE_USAGE_REPORT_DISPLAY as EXAMPLE_REPORT } from '@podium/telemetry/example'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Section } from './shared'

/** Inlined so the web bundle never imports @podium/telemetry (node:fs/crypto).
 *  Structurally checked against the server's wire type by the type system at the
 *  trpc call site below. */
interface TelemetryStateWire {
  usage: 'on' | 'off' | 'absent'
  crash: 'on' | 'off' | 'absent'
  installId?: string
  since?: number
  suppressedBy?: 'DO_NOT_TRACK' | 'PODIUM_TELEMETRY'
  endpoint: string
}

const TIERS: { key: 'usage' | 'crash'; name: string; description: string }[] = [
  {
    key: 'usage',
    name: 'Anonymous usage reports',
    description:
      'One report a day: version, OS, how many machines and sessions, which features you use. Counts and buckets only.',
  },
  {
    key: 'crash',
    name: 'Crash reports',
    description:
      'The error type and the Podium source lines it came from. Error messages are dropped entirely; frames outside Podium are dropped, not rewritten.',
  },
]

export function PrivacySection(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [state, setState] = useState<TelemetryStateWire | null>(null)
  const [preview, setPreview] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    trpc.telemetry.state
      .query()
      .then((s) => setState(s as TelemetryStateWire))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    trpc.telemetry.preview
      .query()
      .then(setPreview)
      .catch(() => {})
  }, [trpc])

  useEffect(load, [load])

  const setTier = async (key: 'usage' | 'crash', on: boolean): Promise<void> => {
    const previous = state
    setError(null)
    setBusy(true)
    // Optimistic: the switch must feel like a switch, not a form.
    if (state) setState({ ...state, [key]: on ? 'on' : 'off' })
    try {
      setState(
        (await trpc.telemetry.set.mutate({ [key]: on ? 'on' : 'off' })) as TelemetryStateWire,
      )
      trpc.telemetry.preview
        .query()
        .then(setPreview)
        .catch(() => {})
    } catch (e) {
      setState(previous)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const resetId = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setState((await trpc.telemetry.resetId.mutate()) as TelemetryStateWire)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const suppressed = state?.suppressedBy
  const shown = preview ? JSON.stringify(preview, null, 2) : EXAMPLE_REPORT

  return (
    <Section
      title="Privacy"
      hint="Podium sends nothing unless you turn it on here. Opt-in, per report type, and reversible at any time."
    >
      {!state && !error && <p className="settings-prose">Loading…</p>}

      {suppressed && (
        <p
          data-testid="telemetry-suppressed"
          className="mb-3 rounded-md border border-border px-3 py-2 text-[13px] text-warning"
        >
          {suppressed} is set in this server's environment — telemetry is disabled entirely,
          whatever these switches say.
        </p>
      )}

      {state &&
        TIERS.map((tier) => (
          <div key={tier.key} className="settings-row">
            <div className="min-w-0">
              <span className="settings-label">{tier.name}</span>
              <p className="settings-prose mt-1">{tier.description}</p>
              {state[tier.key] === 'absent' && <p className="settings-micro mt-1">Never enabled</p>}
            </div>
            <div className="settings-control">
              <Switch
                aria-label={tier.name}
                data-testid={`telemetry-${tier.key}`}
                className="flex-none"
                checked={state[tier.key] === 'on'}
                disabled={busy || Boolean(suppressed)}
                onCheckedChange={(next) => void setTier(tier.key, next === true)}
              />
            </div>
          </div>
        ))}

      {error && (
        <p role="alert" className="settings-prose text-destructive">
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-1">
        <span className="settings-micro uppercase tracking-wide">
          {preview ? 'Your next report' : 'What a report looks like'}
        </span>
        <pre
          data-testid="telemetry-report"
          className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1.5 text-[12px] leading-relaxed"
        >
          {shown}
        </pre>
        <p className="settings-micro">
          Never sent: paths, repo names, branch names, prompts, code, agent output, env vars,
          hostnames, usernames. Your IP is dropped at ingest and never reaches analytics.
        </p>
      </div>

      {state && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Install id</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[12px]">
            {state.installId ?? '(none — created only when you opt in)'}
          </code>
          {state.installId && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void resetId()}
            >
              Reset
            </Button>
          )}
        </div>
      )}

      {state && (
        <p className="settings-micro mt-2">
          Reports go to <code>{state.endpoint}</code>, which drops your IP and forwards to PostHog.
          From a terminal: <code>podium telemetry show</code> · <code>podium telemetry off</code>
        </p>
      )}
    </Section>
  )
}
