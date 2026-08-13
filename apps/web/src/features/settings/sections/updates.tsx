import type { MachineWire } from '@podium/model/browser'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { shallowEqual } from '@podium/client-core/store'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { useFeature } from '@/lib/use-feature'
import { Row, Section } from './shared'

/** Mirrors @podium/model's UpdateChannel; inlined for the same reason as above. */
type FleetChannel = 'stable' | 'edge' | 'dev'

const CHANNEL_LABELS: Record<FleetChannel, string> = {
  stable: 'Stable',
  edge: 'Edge',
  dev: 'Development',
}

interface FleetMachine {
  id: string
  version: string
  state: 'current' | 'granted' | 'downloading' | 'restarting' | 'rejected' | 'stuck'
  online: boolean
  busy: boolean
}

interface FleetSnapshot {
  targetVersion: string | null
  machines: FleetMachine[]
}

interface VersionInfo {
  appVersion?: string
}

type VersionState = 'unreported' | 'current' | 'behind' | 'ahead'

interface MachineVersionRow {
  id: string
  label: string
  version: string
  versionState: VersionState
  /** The machine's own pin, or null when it follows the fleet default (POD-1882). */
  channelOverride: FleetChannel | null
  /**
   * Why this machine's selected channel has no trusted target right now, already
   * sanitized by the server (POD-1880). A dev channel legitimately has NO target
   * while a bundle is preparing, missing or failed, so this is a normal state to
   * render — not an error — and the page must say it rather than show a blank.
   */
  targetUnavailableReason: string | null
}

/**
 * FLEET DEFAULT channel selector. Persists immediately via the setup tRPC (not part
 * of the settings blob) — mirroring AppearanceSection, which also applies on its own.
 * The channel type is inlined so the web bundle never imports @podium/runtime (node:fs).
 *
 * This control is not decorative and not a duplicate of the per-machine selector in
 * Settings → Machines (POD-1882): it sets the channel every machine follows unless it
 * has pinned one of its own, so it is the fleet-wide answer and the per-machine one is
 * the exception. Development is a Podium-development channel and appears only while
 * Settings → Experimental has "Podium development" on — but the selector itself is
 * always here, because choosing between released channels is ordinary operation.
 */
export function UpdatesSection(): JSX.Element {
  const { trpc, machines } = useStoreSelector(
    (s) => ({ trpc: s.trpc, machines: s.machines }),
    shallowEqual,
  )
  const developing = useFeature('podium-development')
  const [channel, setChannel] = useState<FleetChannel | null>(null)
  // PODIUM_UPDATE_CHANNEL in the deployment's environment beats config.json, and
  // the server resolves machines against the env value. When it is set, the
  // selector must say so rather than offer a write that cannot take (POD-1882).
  const [envForced, setEnvForced] = useState(false)
  const [channelError, setChannelError] = useState<string | null>(null)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null)
  const [readError, setReadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    trpc.setup.channel
      .query()
      .then((c) => {
        if (cancelled) return
        setChannel(c.channel)
        setEnvForced(c.envForced)
      })
      .catch((e) => {
        if (!cancelled) setChannelError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  useEffect(() => {
    let cancelled = false
    Promise.all([trpc.setup.info.query(), trpc.updates.fleet.query()])
      .then(([info, nextFleet]) => {
        if (cancelled) return
        setVersionInfo({ appVersion: info.appVersion })
        setFleet(nextFleet)
      })
      .catch((e) => {
        if (!cancelled) setReadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  const choose = async (next: FleetChannel) => {
    if (next === channel || envForced) return
    const prev = channel
    setChannelError(null)
    setChannel(next) // optimistic
    try {
      const result = await trpc.setup.setChannel.mutate({ channel: next })
      setChannel(result.channel)
      setEnvForced(result.envForced)
    } catch (e) {
      setChannel(prev)
      setChannelError(e instanceof Error ? e.message : String(e))
    }
  }

  // Development is appended, never substituted: the released channels stay in the
  // same place and the same order whether or not the flag is on. A machine already
  // sitting on `dev` keeps its button visible with the flag off, so the selector can
  // never show a state the fleet is not in.
  const options: { value: FleetChannel; label: string }[] = [
    { value: 'stable', label: CHANNEL_LABELS.stable },
    { value: 'edge', label: CHANNEL_LABELS.edge },
    ...(developing || channel === 'dev' ? [{ value: 'dev' as const, label: CHANNEL_LABELS.dev }] : []),
  ]

  const fleetMachines = fleet?.machines ?? []
  const machineRows: MachineVersionRow[] =
    machines.length > 0
      ? machines.map((machine: MachineWire) => {
          const wave = fleetMachines.find((candidate) => candidate.id === machine.id)
          return {
            id: machine.id,
            label: machine.name || machine.hostname || machine.id,
            version: machine.appVersion ?? wave?.version ?? 'unreported',
            channelOverride: (machine.updateChannelOverride ?? null) as FleetChannel | null,
            targetUnavailableReason: machine.targetUnavailableReason ?? null,
            versionState:
              machine.versionState ??
              (wave && fleet?.targetVersion
                ? wave.version === fleet.targetVersion
                  ? 'current'
                  : 'behind'
                : 'unreported'),
          }
        })
      : fleetMachines.map((machine) => ({
          id: machine.id,
          label: machine.id,
          version: machine.version,
          channelOverride: null,
          targetUnavailableReason: null,
          versionState: fleet?.targetVersion
            ? machine.version === fleet.targetVersion
              ? 'current'
              : 'behind'
            : 'unreported',
        }))

  const versionStateLabel = (state: VersionState): string => {
    switch (state) {
      case 'current':
        return 'Current'
      case 'behind':
        return 'Behind target'
      case 'ahead':
        return 'Ahead of target'
      default:
        return 'Not reported'
    }
  }

  return (
    <Section
      title="Updates"
      hint="Which builds the self-updater (podium update) pulls, for this server and every machine that has not pinned a source of its own. stable = released builds · edge = latest from main."
    >
      <Row label="Running version">
        <code className="settings-value">
          {versionInfo?.appVersion ?? <span className="settings-micro font-sans">Loading…</span>}
        </code>
      </Row>
      <Row
        label="Target version"
        description="The version this server is asking its places to run."
      >
        <code className="settings-value">
          {fleet === null ? (
            <span className="settings-micro font-sans">Loading…</span>
          ) : (
            (fleet.targetVersion ?? (
              <span className="settings-micro font-sans">None published</span>
            ))
          )}
        </code>
      </Row>
      <Row label="Machines" description="Each machine's reported version compared with the target.">
        <div className="w-full overflow-hidden rounded-md border border-border/70 bg-muted/15">
          {machineRows.length === 0 ? (
            <p className="settings-prose px-3 py-2">
              {fleet === null ? 'Loading…' : 'No machines connected.'}
            </p>
          ) : (
            <div className="divide-y divide-border/60">
              {machineRows.map((machine) => (
                <div
                  key={machine.id}
                  data-testid={`update-machine-${machine.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
                >
                  {/* A machine reads as prose ink lifted to `--foreground` over its
                      version in the machine voice — the same name-then-answer pair
                      the rows above make, one step in because this panel sits
                      inside a row rather than beside one. */}
                  <div className="min-w-0">
                    <p className="truncate settings-prose text-foreground">{machine.label}</p>
                    <code className="settings-micro font-mono">{machine.version}</code>
                  </div>
                  <span className="settings-micro text-right">
                    {versionStateLabel(machine.versionState)}
                    {/* An override is disclosed HERE, on the page that is always
                        visible, so hiding the per-machine selector behind the
                        Podium-development flag can never hide the fact that a
                        machine is not on the fleet default (POD-1882). */}
                    {machine.channelOverride && (
                      <span className="block text-warning">
                        Pinned: {CHANNEL_LABELS[machine.channelOverride]}
                      </span>
                    )}
                    {machine.targetUnavailableReason && (
                      <span
                        className="block max-w-[36ch] text-warning"
                        title={machine.targetUnavailableReason}
                      >
                        No target: {machine.targetUnavailableReason}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Row>
      <Row
        label="Fleet default channel"
        description="Machines follow this unless one has been pinned to its own source."
      >
        {channel === null ? (
          <span className="settings-micro">Loading…</span>
        ) : (
          <div className="flex gap-1">
            {options.map((o) => (
              <Button
                key={o.value}
                type="button"
                size="sm"
                variant={channel === o.value ? 'default' : 'outline'}
                aria-pressed={channel === o.value}
                disabled={envForced}
                onClick={() => void choose(o.value)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        )}
      </Row>
      {envForced && (
        <p className="mt-2 settings-prose text-warning">
          PODIUM_UPDATE_CHANNEL is set in this deployment&rsquo;s environment and overrides the
          configured channel. Unset it to choose the fleet default here.
        </p>
      )}
      {channelError && <p className="mt-2 settings-prose text-destructive">{channelError}</p>}
      {readError && <p className="mt-2 settings-prose text-destructive">{readError}</p>}
    </Section>
  )
}
