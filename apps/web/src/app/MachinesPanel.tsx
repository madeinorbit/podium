// Per-machine update controls stay here until the Updates page takes ownership.
import { useCommands } from '@podium/client-core/react'
import { observer } from '@podium/client-graph/react'
import type { MachineFacts, UpdateChannel } from '@podium/model/browser'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { sourceUnavailableProse } from '@/features/settings/sections/updates-view'
import type { FailureReason } from '@/features/updates/MachineFailureReason'
import { formatDisplayedVersion } from '@/lib/machine-version-skew'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import { updateStatus } from '@/lib/update-status'
import { useFeature } from '@/lib/use-feature'

/** One machine's server-side convergence, as the fleet read model reports it. */
export interface MachineConvergence {
  reason?: FailureReason
  state: ConvergenceRowState
  detail?: string
}

/**
 * Convergence for every row, owned by the panel rather than the row.
 *
 * It is the update-status reader's fleet (POD-6683), so a row shows its progress
 * no matter who started the update: this row's Apply, the global update panel,
 * or a wave that was already running before this page loaded. The open panel is
 * an update screen, so the reader polls while it shows, every second while any
 * machine is converging.
 */
export function useFleetConvergence(): {
  rows: ReadonlyMap<string, MachineConvergence>
  refresh: () => void
} {
  const status = updateStatus()
  useEffect(() => status.watch(), [status])
  const fleet = status.fleet
  // Rebuilt only when a new fleet reading lands, so rows redraw on news alone.
  const rows = useMemo(() => {
    const next = new Map<string, MachineConvergence>()
    for (const machine of fleet?.allMachines ?? fleet?.machines ?? []) {
      next.set(machine.id, {
        state: machine.state as ConvergenceRowState,
        reason: machine.reason,
        ...(machine.detail ? { detail: machine.detail } : {}),
      })
    }
    return next
  }, [fleet])
  return { rows, refresh: () => void status.refresh() }
}

const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
  dev: 'Development',
  edge: 'Edge',
  stable: 'Stable',
}

type ConvergenceRowState =
  | 'current'
  | 'granted'
  | 'downloading'
  | 'restarting'
  | 'rejected'
  | 'stuck'

const CONVERGENCE_IN_FLIGHT: ReadonlySet<ConvergenceRowState> = new Set([
  'granted',
  'downloading',
  'restarting',
])

/**
 * What the operator sees while a grant is in flight. Deliberately coarse: the
 * server reports a machine phase, not transferred bytes, so this must not imply
 * byte-level progress it cannot know.
 */
const CONVERGENCE_PROGRESS_LABELS: Record<string, string> = {
  granted: 'Starting update…',
  downloading: 'Downloading update…',
  restarting: 'Restarting…',
}

/** The outcome vocabulary the machine row speaks, keyed off the server's verdict. */
export function describeApplyOutcome(
  outcome: {
    result: string
    state?: string
    reason?: string
    version?: string
    /** The machine's own platform, for the two POD-2783 refusals that are about it. */
    platform?: string
  },
  machineName: string,
): { tone: 'progress' | 'ok' | 'error'; message: string } {
  switch (outcome.result) {
    case 'granted':
      return {
        tone: 'progress',
        message: `Updating ${machineName} to ${outcome.version}…`,
      }
    case 'source-checkout':
      return {
        tone: 'error',
        message:
          machineName +
          ' runs from a source checkout. Update its checkout and restart Podium from the terminal.',
      }
    case 'already-current':
      return { tone: 'ok', message: `${machineName} is already up to date.` }
    case 'in-flight':
      return {
        tone: 'progress',
        message: `${machineName} is already updating. Wait for it to finish.`,
      }
    case 'legacy-instance-trust':
      return {
        tone: 'error',
        message:
          `${machineName} predates channel-keyed update trust. It can receive this development ` +
          'feed, but its updater will verify it with the baked release key instead of the pinned ' +
          'instance key. Changing or rotating that key cannot make this build use its pin; use ' +
          'the supported host-local stranded-machine repair.',
      }
    /**
     * THE ROW THAT CANNOT BE FIXED BY PRESSING IT AGAIN (POD-2783).
     *
     * A release's platform list is fixed when it is minted, so a machine that
     * enrolled afterwards can never take that release. Saying so — and saying
     * what does resolve it — is the whole point; the old path granted, waited,
     * and then told the operator to go and check the release.
     */
    case 'platform-not-in-release':
      return {
        tone: 'error',
        message:
          `This update was built before ${machineName} joined, so it has no package for ` +
          `${outcome.platform ?? 'its platform'}. The next update built will include it.`,
      }
    case 'platform-not-published':
      return {
        tone: 'error',
        message:
          `Podium publishes no package for ${outcome.platform ?? "that machine's platform"}, ` +
          `so no update can install on ${machineName}.`,
      }
    case 'offline':
      return {
        tone: 'error',
        message: `${machineName} is not connected. Bring it online, then apply again.`,
      }
    case 'unknown-machine':
      return {
        tone: 'error',
        message: `${machineName} is no longer paired with this server.`,
      }
    case 'no-target':
      return {
        tone: 'error',
        message: outcome.reason
          ? `No update is available for ${machineName}: ${outcome.reason}`
          : `No update is available for ${machineName} on its selected update source.`,
      }
    default:
      return {
        tone: 'error',
        message: `Podium could not start the update on ${machineName}.`,
      }
  }
}

/** Radix Select has no null value, so "no pin" needs a token of its own. */
const FLEET_DEFAULT_VALUE = '__fleet__'

/**
 * A channel choice changes only this machine's durable update authority. Applying
 * is deliberately separate: it issues one convergence grant after the selected
 * authority has resolved a concrete trusted target.
 */
export const MachineUpdateControls = observer(function MachineUpdateControls({
  machine,
  trpc,
  convergence,
  onApplied,
}: {
  machine: MachineFacts
  trpc: import('@/app/trpc').Trpc
  /** This machine's server-side convergence, or null when it is not converging. */
  convergence: MachineConvergence | null
  /** Ask the panel to poll now, so the row shows progress without a delay. */
  onApplied: () => void
}): JSX.Element {
  // The PIN (null = follows the fleet default), not the resolved channel
  // (POD-1882). Read off the machine's record: a change queued on this device
  // shows at once, and one from another device arrives as a record (POD-6644).
  const channel: UpdateChannel | null = machine.updateChannelOverride ?? null
  const targetVersion = machine.targetVersion ?? null
  const unavailableReason = machine.targetUnavailableReason ?? null
  const { setUpdateChannel: setMachineUpdateChannel } = useCommands().machines
  const developing = useFeature('podium-development')
  const [changingChannel, setChangingChannel] = useState(false)
  const [applying, setApplying] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<string | null>(null)
  const deliveryUnavailable =
    machine.presenceSource === 'supervisor' && (machine.deliveryCaps?.length ?? 0) === 0
  const deliveryUnavailableReason =
    machine.services?.crashOwner === 'desktop'
      ? 'Managed by Desktop updater.'
      : 'This install does not advertise an update delivery method.'
  // Convergence for this row is SERVER state, read by the panel. The local
  // `applying` flag only covers the mutation round trip; deriving progress from
  // it alone made the row look idle the instant the grant was issued, and lost
  // it entirely on reload or when the global dialog started the update.
  const converging = convergence !== null && CONVERGENCE_IN_FLIGHT.has(convergence.state)
  const rowState = convergence?.state ?? null
  // An outcome is only OURS to announce once this row has actually watched an
  // update happen — it applied one, or it saw this machine in flight. Without
  // that, the first fleet snapshot of an idle, already-current machine would
  // make every row claim a completion nobody asked for.
  const watching = useRef(false)

  // Report the transition OUT of an in-flight state once, whoever started it.
  useEffect(() => {
    const state = convergence?.state ?? null
    if (state !== null && CONVERGENCE_IN_FLIGHT.has(state)) {
      watching.current = true
      return
    }
    if (state === null || !watching.current) return
    watching.current = false
    if (state === 'rejected' || state === 'stuck') {
      setUpdateStatus(null)
      setUpdateError(
        convergence?.detail
          ? `${machine.name} could not finish the update: ${convergence.detail}`
          : `${machine.name} could not finish the update. Try applying it again.`,
      )
    } else if (state === 'current') {
      setUpdateError(null)
      setUpdateStatus(`${machine.name} is up to date.`)
    }
  }, [convergence?.state, convergence?.detail, machine.name])

  const chooseChannel = async (nextChannel: UpdateChannel | null): Promise<void> => {
    if (nextChannel === channel || changingChannel || busy) return
    setChangingChannel(true)
    setUpdateError(null)
    setUpdateStatus(null)
    try {
      await setMachineUpdateChannel(machine.id, nextChannel)
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error))
    } finally {
      setChangingChannel(false)
    }
  }

  const applyUpdate = async (): Promise<void> => {
    if (busy || changingChannel || !machine.online || !targetVersion || deliveryUnavailable) return
    setApplying(true)
    setUpdateError(null)
    setUpdateStatus(null)
    try {
      const result = await trpc.machines.applyUpdate.mutate({ id: machine.id })
      const said = describeApplyOutcome(result.outcome, machine.name)
      if (said.tone === 'error') setUpdateError(said.message)
      else setUpdateStatus(said.message)
      if (said.tone === 'progress') {
        // This row now owns an update in flight, so it may announce how that
        // update ends even if convergence completes between two polls.
        watching.current = true
        onApplied()
      }
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error))
    } finally {
      setApplying(false)
    }
  }

  const sourceRun = machine.installKind === 'source'
  const alreadyCurrent =
    targetVersion !== null && machine.appVersion !== null && machine.appVersion === targetVersion
  const targetLabel = targetVersion
    ? `Target ${formatDisplayedVersion(targetVersion)}`
    : 'Target unavailable'
  // Busy spans the whole act: the mutation round trip AND the convergence it
  // authorized. The action stays disabled for both.
  const busy = applying || converging
  const retryable = rowState === 'rejected' || rowState === 'stuck'
  const progressLabel =
    (rowState ? CONVERGENCE_PROGRESS_LABELS[rowState] : undefined) ?? 'Starting update…'

  return (
    // A quiet third line under the machine it belongs to, indented to the name's
    // own column and separated by air rather than by a second rule — the run's
    // hairlines already say where one machine ends.
    <div
      className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 pl-4"
      data-machine-update-controls={machine.id}
    >
      {/* Sentence case, not a tracked mono eyebrow: this label repeats once per
          machine, and a caps rule shouted down the whole list. */}
      <span className="settings-micro flex-none">Update source</span>
      {/* POD-1882: choosing a SOURCE PER MACHINE is a Podium-development affordance,
          so the control hides with the flag. What the machine is actually on stays
          readable either way — the Target chip below never hides, and Settings →
          Updates discloses every machine that is pinned away from the fleet default,
          so an override can never become invisible by turning the flag off. */}
      {developing ? (
        <Select
          value={channel ?? FLEET_DEFAULT_VALUE}
          disabled={changingChannel || busy}
          onValueChange={(value) =>
            void chooseChannel(value === FLEET_DEFAULT_VALUE ? null : (value as UpdateChannel))
          }
        >
          <SelectTrigger
            size="sm"
            className="w-[152px] flex-none"
            aria-label={`Update channel for ${machine.name}`}
          >
            <SelectValue>
              {channel === null ? 'Fleet default' : UPDATE_CHANNEL_LABELS[channel]}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* First, and the only one that is not a pin: it hands the machine back. */}
            <SelectItem value={FLEET_DEFAULT_VALUE}>Fleet default</SelectItem>
            <SelectItem value="dev">Development</SelectItem>
            <SelectItem value="edge">Edge</SelectItem>
            <SelectItem value="stable">Stable</SelectItem>
          </SelectContent>
        </Select>
      ) : (
        <span className="flex-none settings-micro" data-machine-update-source={machine.id}>
          {channel === null
            ? 'Fleet default'
            : `${UPDATE_CHANNEL_LABELS[channel]} (pinned for this machine)`}
        </span>
      )}

      {/* A known target is a fact, not an alert: it reads in machine voice like
          the version beside the machine's name, and only takes a badge when
          there is nothing to report. */}
      {targetVersion ? (
        // One element, not a sans word wrapping a mono span: the version string
        // is asserted verbatim elsewhere, and a nested node would answer to it.
        <span className="settings-micro flex-none">{targetLabel}</span>
      ) : (
        <Badge variant="warning" className="h-4 flex-none px-1.5 text-[11px]">
          {targetLabel}
        </Badge>
      )}
      {busy && (
        <span
          className="settings-micro flex flex-none items-center gap-1.5"
          role="status"
          data-machine-update-progress={machine.id}
        >
          <WorkingMark size={13} />
          {progressLabel}
        </span>
      )}

      {/* The action keeps one place in the row. Anything that can appear or
          disappear — reasons, errors, progress — lives on its own line below,
          so a click never moves the button out from under the pointer. */}
      {sourceRun && <span className="settings-micro ml-auto flex-none">Source checkout</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto flex-none"
        disabled={
          busy ||
          changingChannel ||
          !machine.online ||
          !targetVersion ||
          alreadyCurrent ||
          deliveryUnavailable
        }
        hidden={sourceRun}
        aria-busy={busy}
        aria-label={`Apply update to ${machine.name}`}
        title={
          !machine.online
            ? 'This machine must be online to apply its selected target.'
            : deliveryUnavailable
              ? deliveryUnavailableReason
              : (unavailableReason ?? undefined)
        }
        onClick={() => void applyUpdate()}
      >
        {busy ? 'Applying…' : alreadyCurrent ? 'Current' : retryable ? 'Try again' : 'Apply'}
      </Button>

      {(unavailableReason || deliveryUnavailable || updateError || updateStatus) && (
        // min-w-0 as well as basis-full: a flex item's automatic minimum is its
        // min-content width, and these lines are `truncate` (nowrap), so without
        // it the longest reason set the row's width and ran off the pane.
        <div className="flex min-w-0 basis-full flex-col gap-0.5">
          {unavailableReason && (
            <span
              className="min-w-0 truncate settings-micro text-warning!"
              title={unavailableReason}
            >
              {/* §6.3: an internal precondition is never shown as an error. The
                  server's reason is a real fact about this deployment, so it is
                  kept — inside a sentence, after a frame that says what it means
                  for this machine. */}
              {sourceUnavailableProse(
                channel === null ? 'its update source' : UPDATE_CHANNEL_LABELS[channel],
                unavailableReason,
              )}
            </span>
          )}
          {deliveryUnavailable && (
            <span className="min-w-0 settings-micro text-warning!">
              Cannot take delivery: {deliveryUnavailableReason}
            </span>
          )}
          {updateError && (
            <span className="min-w-0 settings-micro text-destructive!" role="alert">
              {updateError}
            </span>
          )}
          {updateStatus && (
            <span className="min-w-0 settings-micro text-success!" role="status">
              {updateStatus}
            </span>
          )}
        </div>
      )}
    </div>
  )
})
