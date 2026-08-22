import type { MachineWire } from '@podium/model/browser'
import { formatDevVersionShort } from '@podium/protocol/update-dev-version'
import { machineNeedsUpdate } from './version-skew'

/**
 * Operator-facing version label. Publisher-minted development versions shorten
 * to `dev.N (sha)`; everything else passes through. Shell version single-
 * sourcing stays POD-2451 — this only formats an already-chosen product string.
 *
 * This lives apart from `version-skew.ts` because that module is on first paint:
 * the shell needs `useServerAppVersion`, while these richer labels and verdicts
 * are only rendered after Settings or Machines has been opened.
 */
export function formatDisplayedVersion(version: string): string {
  return formatDevVersionShort(version)
}

/**
 * IS THIS DIFFERENCE THE DESIGN, OR IS IT SOMEONE'S PROBLEM?
 * (updater-convergence spec §2.2b, §8c decisions 2 and 14.)
 *
 * `expected` is not a gentler `unexpected`. Updates are never applied on their
 * own on any channel — the offer is made and a person accepts it — so a machine
 * sitting behind its target is the mechanism WORKING, waiting for someone. A
 * machine that took the grant and never arrived is not, and the two must not
 * wear the same warning colour, or the colour stops meaning anything.
 */
export type SkewMark = 'expected' | 'unexpected'

/** The convergence phases the fleet snapshot reports for one machine. */
export type MachineConvergenceState =
  | 'current'
  | 'granted'
  | 'downloading'
  | 'restarting'
  | 'rejected'
  | 'stuck'

export interface VersionSkewVerdict {
  /** The status column's wording, in the settings list. */
  label: string
  /** The machine row's pill, lower case. Absent when nothing needs a pill. */
  badge?: string
  mark?: SkewMark
  /** One sentence of reason, when the short answer needs one. */
  note?: string
}

const IN_FLIGHT: ReadonlySet<MachineConvergenceState> = new Set([
  'granted',
  'downloading',
  'restarting',
] as const)

type VersionState = NonNullable<MachineWire['versionState']>

/**
 * What this machine's version state IS, preferring the server's own verdict and
 * falling back to the legacy comparison for servers too old to project one.
 * A machine that has reported no version at all is `unreported` — never
 * `current`, which would be an answer about something nobody looked at.
 */
function versionStateOf(
  machine: Pick<MachineWire, 'inventory' | 'targetVersion' | 'versionState'>,
  serverAppVersion: string | null,
): VersionState {
  if (machine.versionState !== undefined) return machine.versionState
  if (machine.inventory?.podiumVersion == null) return 'unreported'
  return machineNeedsUpdate(machine, serverAppVersion) ? 'behind' : 'current'
}

export function machineVersionSkew(
  machine: Pick<
    MachineWire,
    'inventory' | 'targetVersion' | 'versionState' | 'appVersion' | 'installKind'
  >,
  serverAppVersion: string | null = null,
  convergenceState: MachineConvergenceState | null = null,
): VersionSkewVerdict {
  if (machine.installKind === 'source') {
    return {
      label: 'Source checkout',
      note: 'Update its checkout and restart Podium from the terminal.',
    }
  }
  const state = versionStateOf(machine, serverAppVersion)

  if (state === 'current') return { label: 'Current' }
  if (state === 'unreported') return { label: 'Not reported' }
  if (state === 'ahead') {
    return {
      label: 'Ahead of target',
      badge: 'ahead of target',
      mark: 'unexpected',
      note: 'This machine is running a build its update source does not offer.',
    }
  }

  // Behind, and the rest of this decides WHY.
  if (convergenceState && IN_FLIGHT.has(convergenceState)) {
    return { label: 'Updating…', badge: 'updating' }
  }
  if (convergenceState === 'rejected') {
    return {
      label: 'Update refused',
      badge: 'update refused',
      mark: 'unexpected',
      note: 'This machine turned the update down. Its row says why, and can retry it.',
    }
  }
  if (convergenceState === 'stuck') {
    return {
      label: 'Stuck behind target',
      badge: 'stuck',
      mark: 'unexpected',
      note: 'This machine took the update and never arrived on it.',
    }
  }
  // There is deliberately NO "managed by Podium Desktop" case here any more.
  // The macOS payload moved out of the .app (POD-2508), so a Mac is an ordinary
  // fleet machine that waves move like any other — the old branch would now
  // excuse a machine that really is just waiting to be updated.
  return {
    label: 'Update available',
    badge: 'update available',
    mark: 'expected',
    note: 'Podium never applies an update on its own — this one is waiting to be accepted.',
  }
}
