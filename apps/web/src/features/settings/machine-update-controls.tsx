// Per-machine update actions owned by Settings → Updates.
import { useCommands } from '@podium/client-core/react'
import { observer } from '@podium/client-graph/react'
import { companion } from '@podium/mobx-helpers'
import type { MachineFacts, UpdateChannel } from '@podium/model/browser'
import { action, observable, runInAction } from 'mobx'
import type { JSX } from 'react'
import { useEffect, useMemo } from 'react'
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
import { formatDisplayedVersion } from '@/lib/machine-version-skew'
import { WorkingMark } from '@/lib/motion/WorkingMark'
import { useFeature } from '@/lib/use-feature'

export type { MachineConvergence } from '@/app/MachinesPanel'

import type { MachineConvergence } from '@/app/MachinesPanel'

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

/** Request answers belong to the Updates view; batch and row Apply share them. */
class MachineUpdateAction {
  @observable accessor applying = false
  @observable accessor changingChannel = false
  @observable accessor error: string | null = null
  @observable accessor status: string | null = null
  watching = false

  constructor(
    readonly machine: MachineFacts,
    private readonly trpc: import('@/app/trpc').Trpc,
  ) {}

  @action clear() {
    this.error = null
    this.status = null
  }

  @action async apply(onApplied: () => void): Promise<void> {
    if (this.applying) return
    this.applying = true
    this.clear()
    try {
      const result = await this.trpc.machines.applyUpdate.mutate({ id: this.machine.id })
      const said = describeApplyOutcome(result.outcome, this.machine.name)
      runInAction(() => {
        if (said.tone === 'error') this.error = said.message
        else this.status = said.message
        if (said.tone === 'progress') this.watching = true
      })
      if (said.tone === 'progress') onApplied()
    } catch (error) {
      runInAction(() => {
        this.error = error instanceof Error ? error.message : String(error)
      })
    } finally {
      runInAction(() => {
        this.applying = false
      })
    }
  }

  @action observe(convergence: MachineConvergence | null) {
    const state = convergence?.state ?? null
    if (state !== null && CONVERGENCE_IN_FLIGHT.has(state)) {
      this.watching = true
      return
    }
    if (state === null || !this.watching) return
    this.watching = false
    if (state === 'rejected' || state === 'stuck') {
      this.status = null
      this.error = convergence?.detail
        ? `${this.machine.name} could not finish the update: ${convergence.detail}`
        : `${this.machine.name} could not finish the update. Try applying it again.`
    } else if (state === 'current') {
      this.error = null
      this.status = `${this.machine.name} is up to date.`
    }
  }
}

export class MachineUpdateActions {
  readonly row = companion((machine: MachineFacts) => new MachineUpdateAction(machine, this.trpc))
  constructor(private readonly trpc: import('@/app/trpc').Trpc) {}
}

/** A batch uses the exact same eligibility as an individual Apply. */
export function canApplyMachineUpdate(
  machine: MachineFacts,
  convergence: MachineConvergence | null,
): boolean {
  return (
    machine.online === true &&
    machine.podiumManaged !== false &&
    !machine.revokedAt &&
    !machine.supersededBy &&
    machine.installKind !== 'source' &&
    Boolean(machine.targetVersion) &&
    machine.appVersion !== machine.targetVersion &&
    !(machine.presenceSource === 'supervisor' && (machine.deliveryCaps?.length ?? 0) === 0) &&
    !(convergence && CONVERGENCE_IN_FLIGHT.has(convergence.state))
  )
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
  action: sharedAction,
  compact = false,
}: {
  machine: MachineFacts
  trpc: import('@/app/trpc').Trpc
  /** This machine's server-side convergence, or null when it is not converging. */
  convergence: MachineConvergence | null
  /** Ask the panel to poll now, so the row shows progress without a delay. */
  onApplied: () => void
  action?: MachineUpdateAction
  compact?: boolean
}): JSX.Element {
  // The PIN (null = follows the fleet default), not the resolved channel
  // (POD-1882). Read off the machine's record: a change queued on this device
  // shows at once, and one from another device arrives as a record (POD-6644).
  const channel: UpdateChannel | null = machine.updateChannelOverride ?? null
  const targetVersion = machine.targetVersion ?? null
  const unavailableReason = machine.targetUnavailableReason ?? null
  const { setUpdateChannel: setMachineUpdateChannel } = useCommands().machines
  const developing = useFeature('podium-development')
  const action = useMemo(
    () => sharedAction ?? new MachineUpdateAction(machine, trpc),
    [sharedAction, machine, trpc],
  )
  const { applying, changingChannel } = action
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
  useEffect(() => {
    action.observe(convergence)
  }, [action, convergence])

  const chooseChannel = async (nextChannel: UpdateChannel | null): Promise<void> => {
    if (nextChannel === channel || changingChannel || busy) return
    runInAction(() => {
      action.changingChannel = true
    })
    action.clear()
    try {
      await setMachineUpdateChannel(machine.id, nextChannel)
    } catch (error) {
      runInAction(() => {
        action.error = error instanceof Error ? error.message : String(error)
      })
    } finally {
      runInAction(() => {
        action.changingChannel = false
      })
    }
  }

  const applyUpdate = async (): Promise<void> => {
    if (busy || changingChannel || !canApplyMachineUpdate(machine, convergence)) return
    await action.apply(onApplied)
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
    <div
      className="flex flex-wrap items-center justify-end gap-2"
      data-machine-update-controls={machine.id}
    >
      {/* Sentence case, not a tracked mono eyebrow: this label repeats once per
          machine, and a caps rule shouted down the whole list. */}
      {developing && <span className="settings-micro flex-none">Update channel</span>}
      {/* Per-machine pins are a Podium development tool. */}
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
      ) : null}

      {/* A known target is a fact, not an alert: it reads in machine voice like
          the version beside the machine's name, and only takes a badge when
          there is nothing to report. */}
      {!compact &&
        (targetVersion ? (
          // One element, not a sans word wrapping a mono span: the version string
          // is asserted verbatim elsewhere, and a nested node would answer to it.
          <span className="settings-micro flex-none">{targetLabel}</span>
        ) : (
          <Badge variant="warning" className="h-4 flex-none px-1.5 text-[11px]">
            {targetLabel}
          </Badge>
        ))}
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
        disabled={busy || changingChannel || !canApplyMachineUpdate(machine, convergence)}
        hidden={sourceRun || (compact && alreadyCurrent && !busy)}
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

      {!compact && <MachineUpdateMessages machine={machine} action={action} />}
    </div>
  )
})

export const MachineUpdateMessages = observer(function MachineUpdateMessages({
  machine,
  action,
}: {
  machine: MachineFacts
  action: MachineUpdateAction
}) {
  const unavailableReason = machine.targetUnavailableReason
  const deliveryUnavailable =
    machine.presenceSource === 'supervisor' && (machine.deliveryCaps?.length ?? 0) === 0
  const deliveryUnavailableReason =
    machine.services?.crashOwner === 'desktop'
      ? 'Managed by Desktop updater.'
      : 'This install does not advertise an update delivery method.'
  if (!unavailableReason && !deliveryUnavailable && !action.error && !action.status) return null
  return (
    <div className="flex min-w-0 basis-full flex-col gap-0.5">
      {unavailableReason && (
        <span className="settings-micro">
          <span className="text-warning">
            {sourceUnavailableProse(
              UPDATE_CHANNEL_LABELS[
                machine.updateChannelOverride ?? machine.updateChannel ?? 'stable'
              ],
              unavailableReason,
            )}
          </span>
        </span>
      )}
      {deliveryUnavailable && (
        <span className="settings-micro">
          <span className="text-warning">Cannot take delivery: {deliveryUnavailableReason}</span>
        </span>
      )}
      {action.error && (
        <span className="settings-micro" role="alert">
          <span className="text-destructive">{action.error}</span>
        </span>
      )}
      {action.status && (
        <span className="settings-micro" role="status">
          <span className="text-success">{action.status}</span>
        </span>
      )}
    </div>
  )
})
