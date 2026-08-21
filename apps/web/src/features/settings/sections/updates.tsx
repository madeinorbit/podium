import { shallowEqual } from '@podium/client-core/store'
import type { MachineWire } from '@podium/model/browser'
import type { Operation } from '@podium/protocol'
import { parseOperation } from '@podium/protocol'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/clipboard'
import { pageBuildVersion } from '@/lib/logging/build-version'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { uiSource } from '@/lib/ui-source'
import { useFeature } from '@/lib/use-feature'
import {
  formatDisplayedVersion,
  machineVersionSkew,
  type VersionSkewVerdict,
} from '@/lib/version-skew'
import { Row, Section } from './shared'
import {
  CHANNEL_LABELS,
  type ChannelCheck,
  type ChannelStatusRow,
  channelStatusRows,
  channelUnavailableProse,
  describeCheckOutcome,
  type FleetChannel,
  type HistoryRow,
  historyRows,
} from './updates-view'
import { componentVersions } from './version-rows'

interface FleetMachine {
  id: string
  version: string
  state: 'current' | 'granted' | 'downloading' | 'restarting' | 'rejected' | 'stuck'
  online: boolean
  busy: boolean
}

interface FleetSnapshot {
  appVersion?: string
  servedWebDigest?: string
  servedMobileWeb?: {
    present: boolean
    appVersion?: string
    digest?: string
  }
  targetVersion: string | null
  machines: FleetMachine[]
  /**
   * Every registered machine, whatever its channel — which is what this page
   * needs, since `machines` is only the wave the global dialog accounts for.
   * Absent on a server too old to project it (P8), so it is never assumed.
   */
  allMachines?: FleetMachine[]
  /** POD-2100, additive: absent on a server older than the field (P8). */
  channelChecks?: ChannelCheck[]
}

interface VersionInfo {
  appVersion?: string
}

interface MachineVersionRow {
  id: string
  label: string
  version: string
  /** Expected-or-not, in the same vocabulary the component rows above use. */
  skew: VersionSkewVerdict
  /** The machine's own pin, or null when it follows the fleet default (POD-1882). */
  channelOverride: FleetChannel | null
  /**
   * Why this machine's selected channel has no trusted target right now, already
   * sanitized by the server (POD-1880). A dev channel legitimately has NO target
   * while a bundle is preparing, missing or failed, so this is a normal state to
   * render — not an error — and the page must say it in prose (spec §6.3), which
   * is what `channelUnavailableProse` is for.
   */
  targetUnavailableReason: string | null
}

/** How many operations §9.2.6 retains, and therefore how many are worth asking for. */
const HISTORY_LIMIT = 20

/**
 * THE OPERATOR'S VIEW OF UPDATES (POD-2103, spec §3.7 / §6.3 / §9.2).
 *
 * The update panel is for the update that is happening; this page is for every
 * update that already did, and for the state of the channels those updates come
 * from. "Did the update finish last night?" is answerable here and nowhere else
 * — before this, the only record of a finished update was a toast that had long
 * since evaporated.
 *
 * The channel selector below is not decorative and not a duplicate of the
 * per-machine selector in Settings → Machines (POD-1882): it sets the channel
 * every machine follows unless it has pinned one of its own, so it is the
 * fleet-wide answer and the per-machine one is the exception. Development is a
 * Podium-development channel and appears only while Settings → Experimental has
 * "Podium development" on — but the selector itself is always here, because
 * choosing between released channels is ordinary operation. The channel type is
 * inlined so the web bundle never imports @podium/runtime (node:fs).
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
  const [checks, setChecks] = useState<ChannelCheck[] | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [history, setHistory] = useState<Operation[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkNote, setCheckNote] = useState<string | null>(null)

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
        setChecks(nextFleet.channelChecks ?? [])
      })
      .catch((e) => {
        if (!cancelled) setReadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [trpc])

  /**
   * History is its own read, and its own error. A server too old to have
   * operations at all answers NOT_FOUND here, and that must cost this page the
   * history list and nothing else — the running version, the channels and the
   * selector are all still true and still worth showing (P8).
   */
  useEffect(() => {
    let cancelled = false
    trpc.operations.history
      .query({ kind: 'update', limit: HISTORY_LIMIT })
      .then((rows: unknown[]) => {
        if (cancelled) return
        setHistory(rows.map(parseOperation).filter((row): row is Operation => row !== null))
      })
      .catch((e: unknown) => {
        if (!cancelled) setHistoryError(e instanceof Error ? e.message : String(e))
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
      // The server owns the fleet choice, while this bridge owns the installed shell's native
      // fallback. Development uses the edge desktop feed; desktop has no third release channel.
      const persist = nativeDesktopBridge()?.setUpdateChannel
      if (persist) {
        try {
          await persist(result.channel === 'stable' ? 'stable' : 'edge')
        } catch (e) {
          setChannelError(e instanceof Error ? e.message : String(e))
        }
      }
    } catch (e) {
      setChannel(prev)
      setChannelError(e instanceof Error ? e.message : String(e))
    }
  }

  const checkNow = useCallback(async () => {
    setChecking(true)
    setCheckNote(null)
    try {
      const records = (await trpc.updates.checkNow.mutate()) as ChannelCheck[]
      setChecks(records)
      setCheckNote(describeCheckOutcome(records, Date.now()))
      // The check may have resolved a target that was not there a moment ago, so
      // the fleet read model is now stale in exactly the way the user pressed the
      // button to fix.
      const nextFleet = await trpc.updates.fleet.query()
      setFleet(nextFleet)
      if (nextFleet.channelChecks) setChecks(nextFleet.channelChecks)
    } catch (e) {
      setCheckNote(
        e instanceof Error
          ? `Podium could not check for updates: ${e.message}`
          : 'Podium could not check for updates.',
      )
    } finally {
      setChecking(false)
    }
  }, [trpc])

  // Development is appended, never substituted: the released channels stay in the
  // same place and the same order whether or not the flag is on. A machine already
  // sitting on `dev` keeps its button visible with the flag off, so the selector can
  // never show a state the fleet is not in.
  const options: { value: FleetChannel; label: string }[] = [
    { value: 'stable', label: CHANNEL_LABELS.stable },
    { value: 'edge', label: CHANNEL_LABELS.edge },
    ...(developing || channel === 'dev'
      ? [{ value: 'dev' as const, label: CHANNEL_LABELS.dev }]
      : []),
  ]

  const serverVersion = fleet?.appVersion ?? versionInfo?.appVersion

  /**
   * `allMachines` and not `machines`: the latter is the dev-authority wave the
   * global dialog accounts for, and this page owes one row per machine — an
   * edge or stable machine has its own convergence to show.
   */
  const fleetMachines = fleet?.allMachines ?? fleet?.machines ?? []
  const machineRows: MachineVersionRow[] =
    machines.length > 0
      ? machines.map((machine: MachineWire) => {
          const wave = fleetMachines.find((candidate) => candidate.id === machine.id)
          return {
            id: machine.id,
            label: machine.name || machine.hostname || machine.id,
            version: formatDisplayedVersion(machine.appVersion ?? wave?.version ?? 'unreported'),
            channelOverride: (machine.updateChannelOverride ?? null) as FleetChannel | null,
            targetUnavailableReason: machine.targetUnavailableReason ?? null,
            // Behind-with-a-grant-in-flight, behind-and-stuck and
            // behind-and-waiting-for-a-person are three different situations,
            // and the convergence phase is the only thing that tells them apart
            // (spec §2.2b, §8c decision 14).
            skew: machineVersionSkew(machine, serverVersion ?? null, wave?.state ?? null),
          }
        })
      : fleetMachines.map((machine) => ({
          id: machine.id,
          label: machine.id,
          version: formatDisplayedVersion(machine.version),
          channelOverride: null,
          targetUnavailableReason: null,
          skew: machineVersionSkew(
            {
              versionState: fleet?.targetVersion
                ? machine.version === fleet.targetVersion
                  ? 'current'
                  : 'behind'
                : 'unreported',
            } as Parameters<typeof machineVersionSkew>[0],
            serverVersion ?? null,
            machine.state,
          ),
        }))

  /**
   * A channel's target version, read back from the machines that are on it.
   *
   * Each machine carries the version ITS OWN selected authority advertises,
   * resolved server-side; picking those up per channel is reading the server's
   * answer rather than computing a second one. `dev` additionally has the fleet
   * snapshot's `targetVersion`, which is the same authority seen from the
   * coordinating server's side and is what a fleet with no machines still knows.
   */
  const targetByChannel: Partial<Record<FleetChannel, string | null>> = {}
  if (fleet?.targetVersion) targetByChannel.dev = fleet.targetVersion
  for (const machine of machines as MachineWire[]) {
    const machineChannel = (machine.updateChannelOverride ?? channel) as FleetChannel | null
    if (!machineChannel || !machine.targetVersion) continue
    targetByChannel[machineChannel] ??= machine.targetVersion
  }

  // Every channel the user can select, plus any channel a machine has been
  // pinned to — a pinned channel is one this server checks, so hiding its state
  // would hide the only place that machine's updates can come from.
  const shownChannels: FleetChannel[] = [
    ...options.map((option) => option.value),
    ...(checks ?? []).map((check) => check.channel),
  ].filter((value, index, all): value is FleetChannel => all.indexOf(value) === index)

  const channelRows: ChannelStatusRow[] = channelStatusRows({
    channels: shownChannels,
    checks: checks ?? [],
    targetByChannel,
    now: Date.now(),
  })

  const rows: HistoryRow[] = history ? historyRows(history, Date.now()) : []

  /**
   * §2.2b: ONE LINE WHEN EVERYTHING AGREES, the breakdown when it does not.
   *
   * Each version below comes from the artefact that is running it and from
   * nowhere else — the server's from `/version`, this window's from its own
   * build stamp, the shell's from the bridge, the phone's from the bundle this
   * server serves. Deriving any of them from a sibling or from the channel's
   * target would make the display agree with itself in exactly the cases where
   * the truth is that it should not.
   */
  const versions = componentVersions({
    serverVersion,
    page: { version: pageBuildVersion(), source: uiSource() },
    phone: fleet?.servedMobileWeb,
    servedWebDigest: fleet?.servedWebDigest,
    desktopVersion: nativeDesktopBridge()?.currentVersion,
    channel,
  })
  const showComponentVersions = fleet !== null && versions.single === null
  // Every version this panel prints goes through the same display form, so a
  // minted development target reads `dev.8 (77f0e91)` here exactly as it does
  // in the rows above it (POD-2502).
  const targetVersionLabel = fleet?.targetVersion
    ? formatDisplayedVersion(fleet.targetVersion)
    : null

  return (
    <Section
      title="Updates"
      hint="Which builds the self-updater (podium update) pulls, for this server and every machine that has not pinned a source of its own. stable = released builds · edge = latest from main."
    >
      <Row label="Running version">
        {showComponentVersions ? (
          <dl className="flex w-full flex-col gap-2" data-testid="component-version-breakdown">
            {versions.rows.map((component) => (
              <div key={component.key} data-testid={`component-version-${component.key}`}>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="settings-micro">{component.label}</dt>
                  <dd className="settings-value text-right">
                    {component.prefix && (
                      <span className="settings-micro font-sans">{component.prefix} · </span>
                    )}
                    <span className="font-mono">{component.value}</span>
                  </dd>
                </div>
                {/* An expected difference is the mechanism working (a frame
                    released on its own cadence, a tab that has not reloaded
                    yet); an unexpected one is someone's problem. Same row
                    shape, different ink, so the warning colour keeps meaning
                    something. */}
                {component.note && (
                  // The tone goes on a CHILD span, never beside `settings-micro`
                  // on the same element: the component class wins that cascade
                  // and the warning silently renders in the ordinary ink.
                  <p className="settings-micro">
                    {component.mark === 'unexpected' ? (
                      <span className="text-warning">{component.note}</span>
                    ) : (
                      <>
                        {component.mark === 'expected' ? 'Expected. ' : ''}
                        {component.note}
                      </>
                    )}
                  </p>
                )}
              </div>
            ))}
          </dl>
        ) : (
          <code className="settings-value" data-testid="running-version">
            {versions.single ?? <span className="settings-micro font-sans">Loading…</span>}
          </code>
        )}
      </Row>
      <Row
        label="Target version"
        description="The version this server is asking its places to run."
      >
        <code className="settings-value">
          {fleet === null ? (
            <span className="settings-micro font-sans">Loading…</span>
          ) : (
            (targetVersionLabel ?? <span className="settings-micro font-sans">None published</span>)
          )}
        </code>
      </Row>

      {/* §9.2: the cadence is part of the contract — a daily timer, on-panel-open,
          and this button — so the page says when each channel was last asked and
          what came back, in prose. */}
      <Row
        label="Update channels"
        description="Podium checks each channel daily. What it heard, and when."
      >
        <div className="flex w-full flex-col gap-2">
          <div className="w-full overflow-hidden rounded-md border border-border/70 bg-muted/15">
            {checks === null ? (
              <p className="settings-prose px-3 py-2">Loading…</p>
            ) : (
              <div className="divide-y divide-border/60">
                {channelRows.map((row) => (
                  <div
                    key={row.channel}
                    className="px-3 py-2"
                    data-testid={`channel-${row.channel}`}
                  >
                    <p className="settings-prose text-foreground">{row.label}</p>
                    <p
                      className={
                        row.tone === 'warning' ? 'settings-micro text-warning' : 'settings-micro'
                      }
                    >
                      {row.status}
                    </p>
                    <p className="settings-micro" title={row.checkedAtLabel}>
                      {row.checked}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={checking}
              aria-busy={checking}
              onClick={() => void checkNow()}
            >
              {checking ? 'Checking…' : 'Check now'}
            </Button>
            {checkNote && (
              <span className="settings-micro" role="status">
                {checkNote}
              </span>
            )}
          </div>
        </div>
      </Row>

      <Row
        label="Machines"
        description="Each machine's reported version compared with the target. Podium never applies an update on its own, so a machine with one available is waiting to be told to take it."
      >
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
                    {/* Behind is not one state. A machine waiting for someone to
                        accept an offer is the mechanism working — nothing on any
                        channel applies itself (§8c decision 14) — and a machine
                        that took the grant and never arrived is not. The verdict
                        below is the same one the machine rows in Settings →
                        Machines wear, so the two pages say one thing. */}
                    <span className={machine.skew.mark === 'unexpected' ? 'text-warning' : ''}>
                      {machine.skew.label}
                    </span>
                    {/* Only the rows that are somebody's problem carry their
                        reason. The expected case is said ONCE, in this row's
                        description — a fleet of ten waiting machines repeating
                        the same sentence ten times is noise, and noise is what
                        makes the two lines that matter unreadable. */}
                    {machine.skew.mark === 'unexpected' && machine.skew.note && (
                      <span className="block max-w-[36ch]">{machine.skew.note}</span>
                    )}
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
                        {channelUnavailableProse(
                          machine.channelOverride ?? channel ?? 'stable',
                          machine.targetUnavailableReason,
                        )}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Row>

      {/* §3.7: the audit trail. One row per operation, the failed ones openable
          into §7's three layers with the operation id copyable — which is what
          "share the last failed update" needs instead of a screenshot. */}
      <Row
        label="Recent updates"
        description="The last update operations this server ran, and how they ended."
      >
        <div className="w-full overflow-hidden rounded-md border border-border/70 bg-muted/15">
          {history === null && historyError === null ? (
            <p className="settings-prose px-3 py-2">Loading…</p>
          ) : historyError !== null ? (
            <p className="settings-prose px-3 py-2 text-warning">
              This server does not keep a record of past updates.
            </p>
          ) : rows.length === 0 ? (
            <p className="settings-prose px-3 py-2">No updates have been run on this server yet.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {rows.map((row) => (
                <div key={row.id} className="px-3 py-2" data-testid={`update-operation-${row.id}`}>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3">
                    <div className="min-w-0">
                      <p className="truncate settings-prose text-foreground">{row.version}</p>
                      <p className="settings-micro" title={row.startedAtLabel}>
                        {row.startedRelative}
                        {row.duration ? ` · took ${row.duration}` : ''}
                        {row.retryNote ? ` · ${row.retryNote}` : ''}
                      </p>
                    </div>
                    <span
                      className={
                        row.outcome.tone === 'error'
                          ? 'settings-micro text-destructive'
                          : row.outcome.tone === 'ok'
                            ? 'settings-micro text-success'
                            : 'settings-micro'
                      }
                    >
                      {row.outcome.label}
                    </span>
                  </div>
                  {row.error && (
                    <div className="mt-1">
                      <button
                        type="button"
                        data-pressable
                        className="settings-micro underline"
                        aria-expanded={openRow === row.id}
                        onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                      >
                        {openRow === row.id ? 'Hide details' : 'What happened?'}
                      </button>
                      {openRow === row.id && (
                        <div className="mt-1 flex flex-col gap-1">
                          <p className="settings-prose">{row.error.message}</p>
                          <p className="settings-micro">{row.error.nextAction}</p>
                          {row.error.detail && (
                            <>
                              <pre className="max-w-full overflow-x-auto whitespace-pre-wrap settings-micro font-mono">
                                {row.error.detail}
                              </pre>
                              <div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    copyToClipboard(
                                      row.error?.detail ?? row.id,
                                      'Update details copied',
                                    )
                                  }
                                >
                                  Copy details
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
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
