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

/** The example report, matching the CLI prompt and docs/TELEMETRY.md. Shown by
 *  default: the audience is developers, and the JSON documents itself better
 *  than prose about it. Replaced by the REAL pending report once one exists. */
const EXAMPLE_REPORT = `{
  "schema":    1,
  "installId": "3f9c1a2e-…",
  "version":   "1.4.2",
  "os": "linux", "arch": "x64",
  "installAge": "1-7d",
  "machines":   "2-5",
  "sessions":   { "claude-code": 14, "codex": 2 },
  "features":   { "issues": true, "spec": true, "handoff": false }
}`

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
      {!state && !error && <p className="text-[12px] text-muted-foreground">Loading…</p>}

      {suppressed && (
        <p
          data-testid="telemetry-suppressed"
          className="mb-2 rounded-md border border-border px-3 py-2 text-[12px] text-amber-500"
        >
          {suppressed} is set in this server's environment — telemetry is disabled entirely,
          whatever these switches say.
        </p>
      )}

      {state &&
        TIERS.map((tier) => (
          <div key={tier.key} className="flex items-start gap-2.5 py-1.5 text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="text-foreground">{tier.name}</div>
              <p className="mt-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
                {tier.description}
              </p>
              {state[tier.key] === 'absent' && (
                <p className="mt-0.5 text-[11px] text-muted-foreground/80">Never enabled</p>
              )}
            </div>
            <Switch
              aria-label={tier.name}
              data-testid={`telemetry-${tier.key}`}
              className="mt-0.5 flex-none"
              checked={state[tier.key] === 'on'}
              disabled={busy || Boolean(suppressed)}
              onCheckedChange={(next) => void setTier(tier.key, next === true)}
            />
          </div>
        ))}

      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground uppercase tracking-wide">
          {preview ? 'Your next report' : 'What a report looks like'}
        </span>
        <pre
          data-testid="telemetry-report"
          className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1.5 text-[11px] leading-relaxed"
        >
          {shown}
        </pre>
        <p className="text-[11px] text-muted-foreground">
          Never sent: paths, repo names, branch names, prompts, code, agent output, env vars,
          hostnames, usernames. Your IP is dropped at ingest and never reaches analytics.
        </p>
      </div>

      {state && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-muted-foreground">Install id</span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
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
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Reports go to <code>{state.endpoint}</code>, which drops your IP and forwards to PostHog.
          From a terminal: <code>podium telemetry show</code> · <code>podium telemetry off</code>
        </p>
      )}
    </Section>
  )
}
