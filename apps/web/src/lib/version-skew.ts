import type { MachineWire } from '@podium/model/browser'
import { formatDevVersionShort } from '@podium/protocol'
import { useEffect, useState } from 'react'
import type { Store } from '@/app/store'

/**
 * Operator-facing version label. Publisher-minted development versions shorten
 * to `dev.N (sha)`; everything else passes through. Shell version single-
 * sourcing stays POD-2451 — this only formats an already-chosen product string.
 */
export function formatDisplayedVersion(version: string): string {
  return formatDevVersionShort(version)
}

/**
 * POD-838: the server's own build version, fetched once from setup.info.
 * null while unknown (loading, older server, or a failed probe) — callers must
 * treat that as "no skew signal", never as "up to date".
 */
export function useServerAppVersion(trpc: Store['trpc']): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const info = await trpc.setup.info.query()
        if (!cancelled && typeof info.appVersion === 'string') setVersion(info.appVersion)
      } catch {
        // Version is decorative — a failed probe just means no badge.
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [trpc])
  return version
}

/**
 * Prefer the server's per-machine update verdict: it is derived from the target of
 * the channel selected for this machine. Falling back to the server build is only
 * for compatibility with older servers that did not project channel targets.
 */
export function machineNeedsUpdate(
  machine: Pick<MachineWire, 'inventory' | 'targetVersion' | 'versionState'>,
  serverAppVersion: string | null,
): boolean {
  const daemonVersion = machine.inventory?.podiumVersion

  if (machine.versionState !== undefined) return machine.versionState === 'behind'

  if (machine.targetVersion !== undefined) {
    return (
      daemonVersion != null &&
      machine.targetVersion != null &&
      daemonVersion !== machine.targetVersion
    )
  }

  // Legacy projection: 'dev' carries no comparable release identity.
  return (
    daemonVersion != null &&
    serverAppVersion != null &&
    daemonVersion !== 'dev' &&
    serverAppVersion !== 'dev' &&
    daemonVersion !== serverAppVersion
  )
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
    'inventory' | 'targetVersion' | 'versionState' | 'supervised' | 'appVersion'
  >,
  serverAppVersion: string | null = null,
  convergenceState: MachineConvergenceState | null = null,
): VersionSkewVerdict {
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
  // A supervised daemon's bytes belong to Podium Desktop and no wave will ever
  // move it (POD-2099): saying only "behind" would be an accusation against a
  // machine doing exactly what it should.
  if (machine.supervised === true) {
    return {
      // The label names the OWNER, because that is the question a machine
      // sitting behind its target raises: who moves it, if not the button on
      // this page? The badge says the same thing the other way round.
      label: 'Managed by Podium Desktop',
      badge: 'updates with the app',
      mark: 'expected',
      note: 'Podium Desktop owns this machine’s files, so it moves when the app updates.',
    }
  }
  return {
    label: 'Update available',
    badge: 'update available',
    mark: 'expected',
    note: 'Podium never applies an update on its own — this one is waiting to be accepted.',
  }
}
