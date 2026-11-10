/** Workspace-wide reporting consent and server transcript retention. */
import type { PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useSettingsTrpc } from '@/features/settings/stable-access'
import { useSettingsFrame } from '../settings-frame'
import { forcedNotice, useForcedSetting } from '../use-forced-setting'
import { Row, Section } from './shared'

/** Browser-safe shape; the telemetry package's main entry imports node:fs. */
interface TelemetryStateWire {
  usage: 'on' | 'off' | 'absent'
  crash: 'on' | 'off' | 'absent'
  installId?: string
  suppressedBy?: 'DO_NOT_TRACK' | 'PODIUM_TELEMETRY'
  endpoint: string
}

const TIERS = [
  {
    key: 'usage',
    name: 'Usage reports',
    description:
      'Once a day: version, OS, counts of machines and sessions, which features are used.',
  },
  {
    key: 'crash',
    name: 'Crash reports',
    description:
      'The error type and the Podium source lines it came from. No messages, no outside frames.',
  },
] as const
type Tier = (typeof TIERS)[number]['key']

export const PrivacySection = observer(function PrivacySection({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  const forcedUsage = useForcedSetting('telemetryUsage')
  const forcedCrash = useForcedSetting('telemetryCrash')
  const forced = { usage: forcedUsage, crash: forcedCrash }
  const trpc = useSettingsTrpc()
  const frame = useSettingsFrame()
  const [state, setState] = useState<TelemetryStateWire | null>(null)
  const [error, setError] = useState<{ tier?: Tier; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    trpc.telemetry.state
      .query()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch((error: unknown) => {
        if (alive) setError({ message: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      alive = false
    }
  }, [trpc])

  const writeTier = async (key: Tier, on: boolean): Promise<boolean> => {
    setError(null)
    setBusy(true)
    try {
      setState(await trpc.telemetry.set.mutate({ [key]: on ? 'on' : 'off' }))
      return true
    } catch (error) {
      setError({ tier: key, message: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const setTier = async (key: Tier, on: boolean): Promise<void> => {
    if (!state || busy || state.suppressedBy || forced[key].forced) return
    const previous = state
    const previousOn = key === 'usage' ? previous.usage !== 'off' : previous.crash === 'on'
    setState({ ...previous, [key]: on ? 'on' : 'off' })
    if (!(await writeTier(key, on))) {
      setState(previous)
      return
    }
    toast('Saved', {
      action: { label: 'Undo', onClick: () => void writeTier(key, previousOn) },
    })
  }

  const suppressed = state?.suppressedBy

  return (
    <>
      <Section title="Reports to the Podium team">
        {!state && !error && (
          <p className="settings-prose" role="status">
            Loading…
          </p>
        )}
        {suppressed && (
          <p data-testid="telemetry-suppressed" className="settings-prose mb-3 text-warning">
            {suppressed} is set in this server's environment — reports from this workspace are
            disabled entirely.
          </p>
        )}
        {state &&
          TIERS.map((tier) => (
            <Row
              key={tier.key}
              label={tier.name}
              description={
                <>
                  {tier.description}
                  {forced[tier.key].forced && (
                    <span className="settings-micro mt-1 block">
                      {forcedNotice(forced[tier.key])}
                    </span>
                  )}
                </>
              }
              error={error?.tier === tier.key ? error.message : undefined}
              pending={busy}
            >
              <Switch
                aria-label={tier.name}
                data-testid={`telemetry-${tier.key}`}
                checked={
                  !suppressed &&
                  (tier.key === 'usage' ? state.usage !== 'off' : state.crash === 'on')
                }
                disabled={busy || Boolean(suppressed) || forced[tier.key].forced}
                onCheckedChange={(next) => void setTier(tier.key, next === true)}
              />
            </Row>
          ))}
        {error && !error.tier && (
          <p role="alert" className="settings-prose text-destructive">
            {error.message}
          </p>
        )}
        <Row label="See exactly what is sent">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              frame.openTakeover({
                title: 'What a report contains',
                content: <ReportTakeover />,
              })
            }
          >
            Show report
          </Button>
        </Row>
      </Section>
      <Section title="Transcripts">
        <TranscriptMirrorRow settings={settings} patch={patch} />
      </Section>
    </>
  )
})

/** Request answers belong to this takeover and are dropped when it closes. */
function ReportTakeover(): JSX.Element {
  const trpc = useSettingsTrpc()
  const forcedIdentity = useForcedSetting('telemetryInstallId')
  const forcedSince = useForcedSetting('telemetrySince')
  const [state, setState] = useState<TelemetryStateWire | null>(null)
  const [preview, setPreview] = useState<unknown>(null)
  const [loadingPreview, setLoadingPreview] = useState(true)
  const [example, setExample] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    trpc.telemetry.state
      .query()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : String(error))
      })
    trpc.telemetry.preview
      .query()
      .then((next) => {
        if (alive) setPreview(next)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoadingPreview(false)
      })
    // The same browser-safe example the CLI prints. Keep it out of the initial chunk.
    import('@podium/telemetry/example').then((module) => {
      if (alive) setExample(module.EXAMPLE_USAGE_REPORT_DISPLAY)
    })
    return () => {
      alive = false
    }
  }, [trpc])

  const resetId = async (): Promise<void> => {
    if (busy || loadingPreview || forcedIdentity.forced || forcedSince.forced) return
    setBusy(true)
    setError(null)
    try {
      setState(await trpc.telemetry.resetId.mutate())
      // The preview includes the install id; never leave the old id on screen.
      setPreview(null)
      setPreview(await trpc.telemetry.preview.query().catch(() => null))
      toast('Install id reset')
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Section list={false}>
        <p className="settings-micro mb-2">
          {preview ? 'Next report from this workspace' : 'What a report looks like'}
        </p>
        <pre
          data-testid="telemetry-report"
          className="settings-prose max-w-full overflow-x-auto rounded bg-muted p-4 font-mono"
        >
          {preview ? JSON.stringify(preview, null, 2) : example || 'Loading…'}
        </pre>
      </Section>
      <Section>
        <Row
          label="Install id"
          description={
            <>
              Random. Resetting it makes future reports look like a new install.
              {(forcedIdentity.forced || forcedSince.forced) && (
                <span className="settings-micro mt-1 block">
                  {forcedNotice(forcedIdentity.forced ? forcedIdentity : forcedSince)}
                </span>
              )}
            </>
          }
          error={error}
          pending={busy}
        >
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <code className="settings-micro break-all">
              {state?.installId ?? (state ? 'Created when reports are on' : 'Loading…')}
            </code>
            {state?.installId && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || loadingPreview || forcedIdentity.forced || forcedSince.forced}
                onClick={() => void resetId()}
              >
                Reset
              </Button>
            )}
          </div>
        </Row>
      </Section>
      <p className="settings-micro mt-3">
        Never sent: paths, repo names, branch names, prompts, code, agent output, environment
        variables, hostnames, usernames. IP addresses are dropped at ingest and never reach
        analytics.
      </p>
      {state && (
        <p className="settings-micro mt-2">
          Reports go to <code>{state.endpoint}</code>, which drops IP addresses and forwards to
          PostHog. From a terminal: <code>podium telemetry show</code> ·{' '}
          <code>podium telemetry off</code>
        </p>
      )}
    </>
  )
}

/** setup.info supplies the effective value and the deployment layer forcing it. */
function TranscriptMirrorRow({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  const trpc = useSettingsTrpc()
  const [resolvedOn, setResolvedOn] = useState<boolean | null>(null)
  const [resolvedSource, setResolvedSource] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    trpc.setup.info
      .query()
      .then((info) => {
        if (!alive) return
        setResolvedOn(info.transcriptLake === 'on')
        setResolvedSource(info.transcriptLakeSource ?? null)
      })
      .catch(() => {
        // Older servers leave the stored preference in charge.
        if (!alive) return
        setResolvedOn(null)
        setResolvedSource(null)
      })
    return () => {
      alive = false
    }
  }, [trpc])

  const forcedBy =
    resolvedSource === 'env'
      ? "PODIUM_TRANSCRIPT_LAKE is set in this deployment's environment and overrides this setting."
      : resolvedSource === 'file'
        ? 'config.json sets this for the whole deployment and overrides this setting.'
        : null
  const checked = forcedBy ? (resolvedOn ?? true) : (settings.transcripts.mirror ?? true)
  const label = 'Keep a copy of every transcript on the server'

  return (
    <Row
      setting="transcripts.mirror"
      label={label}
      description={
        <>
          So a session stays searchable after the machine that ran it is gone.
          {forcedBy && <span className="settings-micro mt-1 block text-warning">{forcedBy}</span>}
        </>
      }
      readOnlyValue={checked ? 'On' : 'Off'}
    >
      <Switch
        data-testid="transcript-mirror"
        aria-label={label}
        checked={checked}
        disabled={forcedBy !== null}
        onCheckedChange={(next) =>
          patch({ transcripts: { ...settings.transcripts, mirror: next } })
        }
      />
    </Row>
  )
}
