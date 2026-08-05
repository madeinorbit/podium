import type { MachineWire } from '@podium/model'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { shallowEqual } from '@podium/client-core/store'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { Row, Section } from './shared'

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
}

/** Self-update channel selector. Persists immediately via the setup tRPC (not part of
 * the settings blob) — mirroring AppearanceSection, which also applies on its own. The
 * channel type is inlined so the web bundle never imports @podium/runtime (node:fs). */
export function UpdatesSection(): JSX.Element {
  const { trpc, machines } = useStoreSelector(
    (s) => ({ trpc: s.trpc, machines: s.machines }),
    shallowEqual,
  )
  const [channel, setChannel] = useState<'stable' | 'edge' | null>(null)
  const [channelError, setChannelError] = useState<string | null>(null)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null)
  const [readError, setReadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    trpc.setup.channel
      .query()
      .then((c) => {
        if (!cancelled) setChannel(c)
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

  const choose = async (next: 'stable' | 'edge') => {
    if (next === channel) return
    const prev = channel
    setChannelError(null)
    setChannel(next) // optimistic
    try {
      setChannel(await trpc.setup.setChannel.mutate({ channel: next }))
    } catch (e) {
      setChannel(prev)
      setChannelError(e instanceof Error ? e.message : String(e))
    }
  }

  const options: { value: 'stable' | 'edge'; label: string }[] = [
    { value: 'stable', label: 'Stable' },
    { value: 'edge', label: 'Edge' },
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
      hint="Which builds the self-updater (podium update) pulls. stable = released builds · edge = latest from main."
    >
      <Row label="Running version">
        <code className="font-mono text-[11px] text-foreground">
          {versionInfo?.appVersion ?? <span className="font-sans text-muted-foreground">Loading…</span>}
        </code>
      </Row>
      <Row label="Target version" description="The version this server is asking its places to run.">
        <code className="font-mono text-[11px] text-foreground">
          {fleet === null ? (
            <span className="font-sans text-muted-foreground">Loading…</span>
          ) : (
            fleet.targetVersion ?? <span className="font-sans text-muted-foreground">None published</span>
          )}
        </code>
      </Row>
      <Row label="Machines" description="Each machine's reported version compared with the target.">
        <div className="w-full overflow-hidden rounded-md border border-border/70 bg-muted/15">
          {machineRows.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
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
                  <div className="min-w-0">
                    <p className="truncate text-[11px] text-foreground">{machine.label}</p>
                    <code className="font-mono text-[10px] text-muted-foreground">
                      {machine.version}
                    </code>
                  </div>
                  <span className="text-right text-[10px] text-muted-foreground">
                    {versionStateLabel(machine.versionState)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Row>
      <Row label="Update channel">
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
                onClick={() => void choose(o.value)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        )}
      </Row>
      {channelError && <p className="mt-2 settings-prose text-destructive">{channelError}</p>}
      {readError && <p className="mt-2 settings-prose text-destructive">{readError}</p>}
    </Section>
  )
}
