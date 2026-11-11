import type { MachineModel } from '@podium/client-graph'
import { observer } from '@podium/client-graph/react'
import type { Operation, ReleaseProposal } from '@podium/protocol'
import { parseOperation, ReleaseProposal as ReleaseProposalSchema } from '@podium/protocol'
import { History, Server } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { type FailureReason, MachineFailureReason } from '@/features/updates/MachineFailureReason'
import { UpdateSpaceNotice } from '@/features/updates/UpdateSpaceNotice'
import { copyToClipboard } from '@/lib/clipboard'
import { useAgeNow } from '@/lib/clock-hooks'
import { pageBuildDigest, pageBuildVersion } from '@/lib/logging/build-version'
import { formatDisplayedVersion, machineVersionSkew } from '@/lib/machine-version-skew'
import { nativeDesktopBridge, persistNativeDesktopUpdateChannel } from '@/lib/nativeDesktop'
import { uiSource } from '@/lib/ui-source'
import { updateStatus } from '@/lib/update-status'
import { useFeature } from '@/lib/use-feature'
import {
  canApplyMachineUpdate,
  type MachineConvergence,
  MachineUpdateActions,
  MachineUpdateControls,
  MachineUpdateMessages,
} from '../machine-update-controls'
import { useSettingsMachine, useSettingsMachineIds, useSettingsMachines } from '../readers'
import { useSettingsTrpc } from '../stable-access'
import { DiagnosticLoggingSubsection } from './diagnostic-logging'
import { EntityRow, Row, Section, useSettingsPermitted } from './shared'
import {
  CHANNEL_LABELS,
  type ChannelCheck,
  channelUnavailableProse,
  describeCheckOutcome,
  type FleetChannel,
  type HistoryRow,
  historyRows,
  lastChecked,
} from './updates-view'
import { componentVersions } from './version-rows'

interface FleetMachine {
  reason?: FailureReason
  id: string
  installKind?: string
  version: string
  state: 'current' | 'granted' | 'downloading' | 'restarting' | 'rejected' | 'stuck'
  online: boolean
  busy: boolean
}

interface FleetSnapshot {
  appVersion?: string
  sourceDigest?: string
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

/** How many operations §9.2.6 retains, and therefore how many are worth asking for. */
const HISTORY_LIMIT = 20

/** Updates are the one home for release choices, machine actions and their history. */
export const UpdatesSection = observer(function UpdatesSection(): JSX.Element {
  const trpc = useSettingsTrpc()
  const status = updateStatus()
  useEffect(() => status.watch(), [status])
  const machineIds = useSettingsMachineIds()
  const developing = useFeature('podium-development')
  const admin = useSettingsPermitted('records.instancePreferences.edit')
  const machines = useSettingsMachines()
  const actions = useMemo(() => new MachineUpdateActions(trpc), [trpc])
  const [updatingAll, setUpdatingAll] = useState(false)
  const [channel, setChannel] = useState<FleetChannel | null>(null)
  const channelValue = useRef(channel)
  channelValue.current = channel
  const channelSaving = useRef(false)
  const [channelBusy, setChannelBusy] = useState(false)
  // PODIUM_UPDATE_CHANNEL in the deployment's environment beats config.json, and
  // the server resolves machines against the env value. When it is set, the
  // selector must say so rather than offer a write that cannot take (POD-1882).
  const [envForced, setEnvForced] = useState(false)
  const [channelSource, setChannelSource] = useState<string | undefined>()
  /**
   * WHO REPLACES THIS SERVER'S OWN BINARY (PDM-26). Under `fleet-only` the
   * deployment does — a container image, a CI deploy — and the updater only ever
   * touches the joined machines, so offering a server update here would be a
   * button whose step nothing will take.
   */
  const [updateScope, setUpdateScope] = useState<'all' | 'fleet-only'>('all')
  const [channelError, setChannelError] = useState<string | null>(null)
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
  const fleet: FleetSnapshot | null = status.fleet ?? null
  /** What the last manual check answered, until a fleet reading carries the checks. */
  const [checkRecords, setCheckRecords] = useState<ChannelCheck[] | null>(null)
  const checks: ChannelCheck[] | null = fleet?.channelChecks ?? checkRecords ?? (fleet ? [] : null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const readError = infoError ?? (fleet === null ? (status.fleetError ?? null) : null)
  const [history, setHistory] = useState<Operation[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkNote, setCheckNote] = useState<string | null>(null)
  const proposal: ReleaseProposal | null = status.proposal ?? null
  const [approvingProposal, setApprovingProposal] = useState(false)
  const [proposalError, setProposalError] = useState<string | null>(null)
  const [repairing, setRepairing] = useState(false)
  const [repairNote, setRepairNote] = useState<string | null>(null)
  const desktop = nativeDesktopBridge()
  const desktopMachineId = desktop?.machineId

  useEffect(() => {
    let cancelled = false
    trpc.setup.channel
      .query()
      .then((c) => {
        if (cancelled) return
        setChannel(c.channel)
        setEnvForced(c.envForced)
        setChannelSource(c.channelSource)
        setUpdateScope(c.updateScope ?? 'all')
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
    trpc.setup.info
      .query()
      .then((info) => {
        if (!cancelled) setVersionInfo({ appVersion: info.appVersion })
      })
      .catch((e) => {
        if (!cancelled) setInfoError(e instanceof Error ? e.message : String(e))
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

  const choose = async (next: FleetChannel, announce = true) => {
    if (next === channelValue.current || envForced || channelSaving.current) return
    const prev = channelValue.current
    channelSaving.current = true
    setChannelBusy(true)
    setChannelError(null)
    setChannel(next) // optimistic
    try {
      const result = await trpc.setup.setChannel.mutate({ channel: next })
      setChannel(result.channel)
      setEnvForced(result.envForced)
      setChannelSource(result.channelSource)
      if (announce && prev)
        toast('Saved', { action: { label: 'Undo', onClick: () => void choose(prev, false) } })
      else if (!announce) toast('Change undone')
      // Keep the shell's native fallback on this server's channel. Dev points at
      // this server's public shell manifest; the signed artifact itself remains on GitHub.
      try {
        await persistNativeDesktopUpdateChannel(result.channel, result.desktopUpdateEndpoint)
      } catch (e) {
        setChannelError(e instanceof Error ? e.message : String(e))
      }
    } catch (e) {
      setChannel(prev)
      setChannelError(e instanceof Error ? e.message : String(e))
    } finally {
      channelSaving.current = false
      setChannelBusy(false)
    }
  }

  const checkNow = useCallback(async () => {
    setChecking(true)
    setCheckNote(null)
    try {
      const records = (await trpc.updates.checkNow.mutate()) as ChannelCheck[]
      setCheckRecords(records)
      setCheckNote(describeCheckOutcome(records, Date.now()))
      // The check may have resolved a target that was not there a moment ago, so
      // the fleet read model is now stale in exactly the way the user pressed the
      // button to fix.
      await status.refresh()
    } catch (e) {
      setCheckNote(
        e instanceof Error
          ? `Podium could not check for updates: ${e.message}`
          : 'Podium could not check for updates.',
      )
    } finally {
      setChecking(false)
    }
  }, [status, trpc])

  const approveProposal = useCallback(async () => {
    setApprovingProposal(true)
    setProposalError(null)
    try {
      const approvalMutation = (
        trpc.updates as typeof trpc.updates & {
          approveProposal?: {
            mutate: (input: { headSha: string; version: string }) => Promise<unknown>
          }
        }
      ).approveProposal
      if (!approvalMutation) throw new Error('This server cannot approve development releases.')
      if (!proposal) throw new Error('There is no development release proposal to approve.')
      const raw = await approvalMutation.mutate({
        headSha: proposal.headSha,
        version: proposal.version,
      })
      status.noteProposal(raw === null ? null : ReleaseProposalSchema.parse(raw))
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : String(error))
      // A proposal-moved refusal is immediately actionable only if the stale
      // card is replaced with the proposal the server just named.
      await status.refresh()
    } finally {
      setApprovingProposal(false)
    }
  }, [proposal, status, trpc])

  const repairPayload = useCallback(async () => {
    setRepairing(true)
    setRepairNote(null)
    try {
      if (!admin && desktop?.repairPayload) {
        await desktop.repairPayload()
        setRepairNote(
          'The signed recovery payload was restored. Fleet updates will catch it up after restart.',
        )
        return
      }
      const result = await trpc.updates.repairPayload.mutate(
        desktopMachineId ? { id: desktopMachineId } : undefined,
      )
      status.noteFleet(result.fleet)
      setRepairNote('Repair granted. Podium will download the current payload and restart.')
    } catch (error) {
      if (desktop?.repairPayload) {
        try {
          await desktop.repairPayload()
          setRepairNote(
            'The signed recovery payload was restored. Fleet updates will catch it up after restart.',
          )
          return
        } catch (nativeError) {
          setRepairNote(
            `Podium could not restore the payload: ${
              nativeError instanceof Error ? nativeError.message : String(nativeError)
            }`,
          )
          return
        }
      }
      setRepairNote(
        error instanceof Error
          ? `Podium could not start payload repair: ${error.message}`
          : 'Podium could not start payload repair.',
      )
    } finally {
      setRepairing(false)
    }
  }, [admin, desktop, desktopMachineId, status, trpc])

  const options: { value: FleetChannel; label: string }[] = [
    { value: 'stable', label: CHANNEL_LABELS.stable },
    { value: 'edge', label: CHANNEL_LABELS.edge },
    ...(developing ? [{ value: 'dev' as const, label: CHANNEL_LABELS.dev }] : []),
  ]
  const serverVersion = fleet?.appVersion ?? versionInfo?.appVersion
  const fleetMachines = fleet?.allMachines ?? fleet?.machines ?? []
  const convergenceFor = (id: string): MachineConvergence | null =>
    fleetMachines.find((m) => m.id === id) ?? null
  const waitingMachines = machines.filter(
    (machine) =>
      machine.transferable === true &&
      canApplyMachineUpdate(machine, convergenceFor(machine.id)) &&
      !actions.row(machine).applying &&
      !actions.row(machine).changingChannel,
  )
  const applyAll = async () => {
    if (updatingAll) return
    setUpdatingAll(true)
    try {
      await Promise.all(
        waitingMachines.map((machine) => actions.row(machine).apply(() => void status.refresh())),
      )
    } finally {
      setUpdatingAll(false)
    }
  }
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
    serverDigest: fleet?.sourceDigest,
    page: { version: pageBuildVersion(), digest: pageBuildDigest(), source: uiSource() },
    phone: fleet?.servedMobileWeb,
    servedWebDigest: fleet?.servedWebDigest,
    desktopVersion: nativeDesktopBridge()?.currentVersion,
    channel,
  })
  const showComponentVersions = Boolean(serverVersion) && versions.single === null
  return (
    <>
      <Section title="Version">
        <Row
          label="Podium"
          description={
            showComponentVersions
              ? 'The components are running different builds.'
              : versions.single
                ? 'Server, this window and the desktop app all match.'
                : undefined
          }
        >
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
                  {component.note && (
                    <p className="settings-micro">
                      <span className={component.mark === 'unexpected' ? 'text-warning' : ''}>
                        {component.mark === 'expected' ? 'Expected. ' : ''}
                        {component.note}
                      </span>
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
          label="Update channel"
          description={
            channel === 'stable'
              ? 'Released builds.'
              : channel === 'dev'
                ? 'Builds from this workspace’s development branch.'
                : 'Latest builds from main, a few times a day.'
          }
          readOnly={!admin}
          readOnlyValue={channel ? CHANNEL_LABELS[channel] : 'Loading…'}
          error={channelError}
          pending={channelBusy}
        >
          {channel === null ? (
            <span className="settings-micro">Loading…</span>
          ) : (
            <fieldset
              aria-label="Update channel"
              className="settings-segmented"
              disabled={envForced || channelBusy}
            >
              {options.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={
                    channel === option.value
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground'
                  }
                  aria-pressed={channel === option.value}
                  disabled={envForced}
                  onClick={() => void choose(option.value)}
                >
                  {option.label}
                </Button>
              ))}
              {!developing && channel === 'dev' && (
                <span className="settings-micro self-center px-2">Development</span>
              )}
            </fieldset>
          )}
        </Row>
        {envForced && (
          <p className="settings-list-note settings-prose text-warning">
            {channelSource === 'file' ? 'config.json' : 'PODIUM_UPDATE_CHANNEL'} overrides the
            configured channel. Remove the override to choose the update channel here.
          </p>
        )}
        {updateScope === 'fleet-only' && (
          <p className="settings-list-note settings-prose">
            Server updates are managed by this deployment; machines still update from the{' '}
            {channel ?? 'configured'} feed.
          </p>
        )}
        <Row label="Last checked">
          <LastChecked checks={checks} channel={channel} />
          {admin && (
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
          )}
          {checkNote && (
            <span className="settings-micro" role="status">
              {checkNote}
            </span>
          )}
        </Row>
        {readError && (
          <p className="settings-list-note settings-prose text-destructive" role="alert">
            {readError}
          </p>
        )}
      </Section>
      <Section
        title="Machines"
        list
        action={
          waitingMachines.length > 0 || updatingAll ? (
            <Button
              type="button"
              size="sm"
              disabled={updatingAll}
              aria-busy={updatingAll}
              onClick={() => void applyAll()}
            >
              {updatingAll
                ? 'Starting updates…'
                : `Update ${waitingMachines.length} ${waitingMachines.length === 1 ? 'machine' : 'machines'}`}
            </Button>
          ) : undefined
        }
      >
        {machineIds.map((id) => (
          <SettingsUpdateMachine
            key={id}
            id={id}
            fleetMachines={fleetMachines}
            serverVersion={serverVersion ?? null}
            channel={channel}
            actions={actions}
          />
        ))}
        {admin &&
          machineIds.length === 0 &&
          fleetMachines.map((machine) => (
            <EntityRow
              key={machine.id}
              leading={<Server size={16} />}
              title={machine.id}
              subtitle={
                <>
                  {formatDisplayedVersion(machine.version)}
                  {fleet?.targetVersion ? ` → ${formatDisplayedVersion(fleet.targetVersion)}` : ''}
                  {!machine.online && ' · Offline'}
                </>
              }
              monoSubtitle
              trailing={
                machine.state === 'current' ? (
                  <span className="settings-micro">Current</span>
                ) : (
                  <Badge variant="warning">Update waiting</Badge>
                )
              }
            />
          ))}
        {machineIds.length === 0 && fleetMachines.length === 0 && (
          <p className="settings-list-note settings-prose">
            {fleet === null ? 'Loading…' : 'No machines connected.'}
          </p>
        )}
        <div className="settings-list-note">
          <UpdateSpaceNotice client={trpc} scope="all" />
        </div>
      </Section>
      <Section title="History" list>
        {history === null && historyError === null ? (
          <p className="settings-list-note settings-prose">Loading…</p>
        ) : historyError ? (
          <p className="settings-list-note settings-prose text-warning">
            This server does not keep a record of past updates.
          </p>
        ) : rows.length === 0 ? (
          <p className="settings-list-note settings-prose">
            No updates have been run on this server yet.
          </p>
        ) : (
          rows.map((row) => (
            <div key={row.id} data-testid={`update-operation-${row.id}`}>
              <EntityRow
                leading={<History size={16} />}
                title={<span className="settings-value">{row.version}</span>}
                subtitle={
                  <span title={row.startedAtLabel}>
                    {row.startedRelative}
                    {row.duration ? ` · took ${row.duration}` : ''}
                    {row.retryNote ? ` · ${row.retryNote}` : ''}
                  </span>
                }
                trailing={
                  <>
                    <Badge
                      variant={
                        row.outcome.tone === 'error'
                          ? 'destructive'
                          : row.outcome.tone === 'ok'
                            ? 'success'
                            : row.outcome.tone === 'warning'
                              ? 'warning'
                              : 'secondary'
                      }
                    >
                      {row.outcome.label}
                    </Badge>
                    {row.error && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-expanded={openRow === row.id}
                        aria-controls={`update-details-${row.id}`}
                        onClick={() => setOpenRow(openRow === row.id ? null : row.id)}
                      >
                        Why?
                      </Button>
                    )}
                  </>
                }
              />
              {row.error && openRow === row.id && (
                <div
                  id={`update-details-${row.id}`}
                  className="settings-list-note flex flex-col gap-2"
                >
                  <p className="settings-prose">{row.error.message}</p>
                  <p className="settings-micro">{row.error.nextAction}</p>
                  {row.error.detail && (
                    <>
                      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap settings-micro font-mono">
                        {row.error.detail}
                      </pre>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-fit"
                        onClick={() =>
                          copyToClipboard(row.error?.detail ?? row.id, 'Update details copied')
                        }
                      >
                        Copy details
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </Section>
      <Section title="Troubleshooting">
        <DiagnosticLoggingSubsection />
        {desktop &&
          (admin || desktop.repairPayload !== undefined) &&
          (desktop.launchMode !== 'client' || desktop.repairPayload !== undefined) && (
            <Row
              label="Repair this installation"
              description="Downloads the current version again and restarts. Desktop app only."
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={repairing}
                aria-busy={repairing}
                onClick={() => void repairPayload()}
              >
                {repairing ? 'Starting repair…' : 'Repair'}
              </Button>
              {repairNote && (
                <span className="settings-micro" role="status">
                  {repairNote}
                </span>
              )}
            </Row>
          )}
      </Section>
      {developing && admin && (
        <Section title="Development release">
          {proposal ? (
            <Row
              label="Build and publish"
              description="Build this proposal, then choose when to apply it."
            >
              <div className="flex w-full flex-col gap-2" data-testid="settings-release-proposal">
                <p className="settings-prose">
                  Build {formatDisplayedVersion(proposal.version)} for the fleet.
                </p>
                {proposal.runningVersion && (
                  <p
                    className="settings-micro"
                    data-testid="settings-release-proposal-server-transition"
                  >
                    Server: {formatDisplayedVersion(proposal.runningVersion)} →{' '}
                    {formatDisplayedVersion(proposal.version)}
                  </p>
                )}
                <p className="settings-micro">
                  {proposal.branch} · {proposal.headSha}
                </p>
                {proposal.commits.length > 0 ? (
                  <ul aria-label="Commits in proposed release">
                    {proposal.commits.map((commit) => (
                      <li key={commit.sha} className="settings-micro">
                        <code className="mr-2">{commit.sha}</code>
                        {commit.summary}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="settings-micro">No changes since what this server is running.</p>
                )}
                {proposal.addedMigrations.length > 0 && (
                  <p
                    className="settings-micro"
                    data-testid="settings-release-proposal-migration-warning"
                  >
                    <span className="text-warning">
                      Adds {proposal.addedMigrations.length}{' '}
                      {proposal.addedMigrations.length === 1 ? 'migration; ' : 'migrations; '}
                      releasing commits fleet databases to this branch until it merges.
                    </span>
                  </p>
                )}
                {proposal.approval && (
                  <p className="settings-micro">
                    Approved by <code>{proposal.approval.approvedBy}</code>.
                  </p>
                )}
                {proposal.failure && (
                  <details className="settings-micro">
                    <summary className="text-destructive">{proposal.failure.message}</summary>
                    <pre className="mt-2 whitespace-pre-wrap">{proposal.failure.logs}</pre>
                  </details>
                )}
                {proposalError && (
                  <p className="settings-micro" role="alert">
                    <span className="text-destructive">{proposalError}</span>
                  </p>
                )}
                <Button
                  type="button"
                  size="sm"
                  className="w-fit"
                  disabled={approvingProposal || proposal.state === 'building'}
                  pending={approvingProposal || proposal.state === 'building'}
                  pendingLabel="Building…"
                  onClick={() => void approveProposal()}
                >
                  {proposal.state === 'failed' ? 'Try build again' : 'Build and publish'}
                </Button>
              </div>
            </Row>
          ) : (
            <p className="settings-list-note settings-prose">
              No development release is waiting to be built.
            </p>
          )}
        </Section>
      )}
    </>
  )
})

function LastChecked({
  checks,
  channel,
}: {
  checks: ChannelCheck[] | null
  channel: FleetChannel | null
}) {
  const check = checks?.find((record) => record.channel === channel)
  const now = useAgeNow(check?.checkedAt ?? 0, 0, Boolean(check))
  const reading = lastChecked(check, now)
  return (
    <span className="settings-micro" title={reading.title}>
      {checks === null ? 'Loading…' : reading.label}
    </span>
  )
}

const SettingsUpdateMachine = observer(function SettingsUpdateMachine({
  id,
  fleetMachines,
  serverVersion,
  channel,
  actions,
}: {
  id: string
  fleetMachines: FleetMachine[]
  serverVersion: string | null
  channel: FleetChannel | null
  actions: MachineUpdateActions
}): JSX.Element | null {
  const machine = useSettingsMachine(id)
  const admin = useSettingsPermitted('records.instancePreferences.edit')
  return machine && (admin || machine.transferable === true) ? (
    <UpdateMachineRow
      machine={machine}
      wave={fleetMachines.find((row) => row.id === id) ?? null}
      serverVersion={serverVersion}
      channel={channel}
      actions={actions}
    />
  ) : null
})

const UpdateMachineRow = observer(function UpdateMachineRow({
  machine,
  wave,
  serverVersion,
  channel,
  actions,
}: {
  machine: MachineModel
  wave: FleetMachine | null
  serverVersion: string | null
  channel: FleetChannel | null
  actions: MachineUpdateActions
}) {
  const trpc = useSettingsTrpc()
  const status = updateStatus()
  const developing = useFeature('podium-development')
  const skew = machineVersionSkew(
    machine,
    serverVersion,
    wave?.reason ? 'rejected' : (wave?.state ?? null),
  )
  const target = machine.targetVersion
  const waiting = Boolean(target && machine.appVersion !== target)
  const inFlight = wave && ['granted', 'downloading', 'restarting'].includes(wave.state)
  return (
    <div data-testid={`update-machine-${machine.id}`}>
      <EntityRow
        leading={<Server size={16} />}
        title={machine.name || machine.hostname || machine.id}
        subtitle={
          <>
            <span className="font-mono">
              {formatDisplayedVersion(machine.appVersion ?? wave?.version ?? 'unreported')}
              {waiting && target ? ` → ${formatDisplayedVersion(target)}` : ''}
            </span>
            {!machine.online && <span> · Offline</span>}
            {machine.installKind === 'source' && <span> · Source checkout</span>}
            {developing && machine.updateChannelOverride && (
              <span> · Pinned: {CHANNEL_LABELS[machine.updateChannelOverride]}</span>
            )}
            <MachineFailureReason reason={wave?.reason} />
            {machine.transferable === true && (
              <MachineUpdateMessages machine={machine} action={actions.row(machine)} />
            )}
            {skew.mark === 'unexpected' && skew.note && (
              <span className="block text-warning">{skew.note}</span>
            )}
            {machine.transferable !== true && machine.targetUnavailableReason && (
              <span className="block">
                {channelUnavailableProse(
                  machine.updateChannelOverride ?? channel ?? 'stable',
                  machine.targetUnavailableReason,
                )}
              </span>
            )}
          </>
        }
        trailing={
          <>
            {!inFlight &&
              (skew.label === 'Failed' ? (
                <Badge variant="destructive">Failed</Badge>
              ) : waiting || skew.label === 'Update available' ? (
                <Badge variant="warning">Update waiting</Badge>
              ) : target ? (
                <span className="settings-micro">Current</span>
              ) : (
                <span className="settings-micro">{skew.label}</span>
              ))}
            {machine.transferable === true &&
              machine.podiumManaged !== false &&
              !machine.revokedAt &&
              !machine.supersededBy && (
                <MachineUpdateControls
                  compact
                  machine={machine}
                  trpc={trpc}
                  action={actions.row(machine)}
                  convergence={wave}
                  onApplied={() => void status.refresh()}
                />
              )}
          </>
        }
      />
    </div>
  )
})
