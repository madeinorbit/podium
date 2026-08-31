/**
 * Read-only operations status for pocket capacity and Settings fleet/device
 * readouts.
 *
 * The inputs already carry the authority's disclosure decisions. Machine rows
 * are the per-principal `machines.list` projection, so an invisible machine is
 * absent and a visible-but-not-usable one carries `use: denied`. Device rows
 * come from the authenticated user's own `/auth/client-sessions` result. This
 * module never attempts to reconstruct either policy from owner ids (which do
 * not cross the wire) and never turns a missing detail into permission.
 */

import {
  type HostMetricsWire,
  type MachineId,
  type MachineQuotaWire,
  type MachineWire,
  type QuotaWindowHistoryWire,
  quotaAccountKey,
  type UpdateChannel,
} from '@podium/model'
import type { HostMemoryBreakdown, MobileClientSession } from '@podium/protocol'
import { relativeTime } from '../focus'
import { type MachineAvailability, machineViewsFromWire } from './slices/machines/authority'
import {
  type HostDiskView,
  type HostLoadView,
  type HostMemoryView,
  hostDiskView,
  hostLoadView,
  hostMemoryView,
} from './slices/machines/facts'

export type MachineCapacityReading =
  | { state: 'loading'; value: HostMemoryBreakdown | null }
  | { state: 'ready'; value: HostMemoryBreakdown }
  | { state: 'stale'; value: HostMemoryBreakdown }
  | { state: 'unavailable'; value: null }

export type MachineCapacityReadings = Readonly<Partial<Record<MachineId, MachineCapacityReading>>>

export type CapacityDetailState = MachineCapacityReading['state'] | 'restricted' | 'offline'

export interface MachineOperationsView {
  id: MachineId
  name: string
  hostname: string
  online: boolean
  availability: MachineAvailability
  statusLabel: string
  memory: HostMemoryView | null
  load: HostLoadView | null
  disk: HostDiskView | null
  capacityDetail: CapacityDetailState
  capacityLabel: string
  sampledAt: string | null
  appVersion: string | null
  targetVersion: string | null
  updateChannel: UpdateChannel | null
  updateState: NonNullable<MachineWire['versionState']> | 'unknown'
  updateLabel: string
}

export interface VisibleFleetOperationsView {
  machines: MachineOperationsView[]
  visibleCount: number
  onlineCount: number
  usableCount: number
  fleetLabel: string
  updateLabel: string
  currentCount: number
  behindCount: number
  aheadCount: number
  unreportedCount: number
}

/**
 * Host metrics are use-gated machine facts even when an older server broadcasts
 * the unfiltered host stream. Never let a visible-but-denied or invisible host
 * reach a capacity summary.
 */
export function useGrantedHostMetrics(
  machines: readonly MachineWire[],
  hosts: readonly HostMetricsWire[],
): HostMetricsWire[] {
  const grantedIds = new Set(
    machineViewsFromWire([...machines])
      .filter((view) => view.grants.use)
      .map((view) => view.machine.id),
  )
  return hosts.filter((host) => {
    if (host.machineId) return grantedIds.has(host.machineId)
    return machines.length === 1 && grantedIds.has(machines[0]!.id)
  })
}

/** Quota readings are also use-gated machine facts. */
export function useGrantedMachineQuota(
  machines: readonly MachineWire[],
  quota: readonly MachineQuotaWire[],
): MachineQuotaWire[] {
  const grantedIds = new Set(
    machineViewsFromWire([...machines])
      .filter((view) => view.grants.use)
      .map((view) => view.machine.id),
  )
  return quota.filter((reading) => grantedIds.has(reading.machineId))
}

/**
 * The history endpoint predates principal projection, so fail closed to account
 * keys established by live quota on visible use-granted machines. Machine-key
 * fallbacks remain readable for an authorized offline account.
 */
export function useGrantedQuotaHistory(
  machines: readonly MachineWire[],
  quota: readonly MachineQuotaWire[],
  history: readonly QuotaWindowHistoryWire[],
): QuotaWindowHistoryWire[] {
  const grantedQuota = useGrantedMachineQuota(machines, quota)
  const allowed = new Set<string>()
  for (const reading of grantedQuota) {
    for (const agent of reading.agents) {
      allowed.add(quotaAccountKey(agent.agent, agent.account?.email, reading.machineId))
    }
  }
  const grantedIds = machineViewsFromWire([...machines])
    .filter((view) => view.grants.use)
    .map((view) => view.machine.id)
  for (const row of history) {
    for (const machineId of grantedIds) {
      allowed.add(quotaAccountKey(row.agent, undefined, machineId))
    }
  }
  return history.filter((row) => allowed.has(row.accountKey))
}

function machineHost(
  machine: MachineWire,
  machines: readonly MachineWire[],
  hosts: readonly HostMetricsWire[],
): HostMetricsWire | undefined {
  const exact = hosts.find((host) => host.machineId === machine.id)
  if (exact) return exact
  // Mixed-version single-machine servers may send the pre-machine-id host
  // sample. It is only placeable when there is exactly one visible machine.
  return machines.length === 1 ? hosts.find((host) => host.machineId === undefined) : undefined
}

function effectiveUpdateState(machine: MachineWire): MachineOperationsView['updateState'] {
  if (machine.versionState) return machine.versionState
  if (machine.appVersion && machine.targetVersion && machine.appVersion === machine.targetVersion) {
    return 'current'
  }
  return 'unknown'
}

function machineUpdateLabel(
  machine: MachineWire,
  state: MachineOperationsView['updateState'],
): string {
  const installed = machine.appVersion ?? 'version not reported'
  if (state === 'current') return `${installed} · current`
  if (state === 'behind') {
    return machine.targetVersion
      ? `${installed} → ${machine.targetVersion}`
      : `${installed} · behind`
  }
  if (state === 'ahead') {
    return machine.targetVersion
      ? `${installed} · ahead of ${machine.targetVersion}`
      : `${installed} · ahead`
  }
  if (state === 'unreported') return 'Build not reported'
  if (machine.targetUnavailableReason) return `${installed} · target unavailable`
  return installed
}

/**
 * Project visible machine rows plus the capacity detail the caller was allowed
 * to fetch. Capacity readings must contain only answers from the live
 * use-gated host command. This function never fills a denied row from another
 * machine.
 */
export function visibleFleetOperations(args: {
  machines: readonly MachineWire[]
  hosts: readonly HostMetricsWire[]
  capacityReadings?: MachineCapacityReadings
  loadPerCore?: number | null
  nowMs?: number
}): VisibleFleetOperationsView {
  const wireMachines = [...args.machines]
  const views = machineViewsFromWire(wireMachines)
  const machines = views.map(({ machine, grants, availability }): MachineOperationsView => {
    const host = grants.use ? machineHost(machine, wireMachines, args.hosts) : undefined
    const capacityReading = grants.use ? args.capacityReadings?.[machine.id] : undefined
    const breakdown = capacityReading?.value ?? undefined
    const memoryHost =
      host ??
      (breakdown
        ? {
            hostname: breakdown.hostname,
            machineId: machine.id,
            name: machine.name,
            sampledAt: breakdown.sampledAt,
            memory: breakdown.memory,
          }
        : undefined)
    // A cached answer never widens a revoked grant: once `use` is denied the
    // detail becomes absent immediately, even before the caller prunes cache.
    const disk = breakdown?.disk ? hostDiskView(breakdown.disk) : null
    const capacityDetail: CapacityDetailState = !grants.use
      ? 'restricted'
      : !machine.online
        ? 'offline'
        : (capacityReading?.state ?? 'unavailable')
    const capacityLabel =
      capacityDetail === 'restricted'
        ? 'Machine access required'
        : capacityDetail === 'offline'
          ? breakdown
            ? `Offline · sampled ${relativeTime(breakdown.sampledAt, args.nowMs ?? Date.now())}`
            : 'Offline'
          : capacityDetail === 'loading'
            ? breakdown
              ? `Refreshing · sampled ${relativeTime(breakdown.sampledAt, args.nowMs ?? Date.now())}`
              : 'Reading capacity'
            : capacityDetail === 'stale'
              ? breakdown
                ? `Stale · sampled ${relativeTime(breakdown.sampledAt, args.nowMs ?? Date.now())}`
                : 'Capacity unavailable'
              : capacityDetail === 'unavailable'
                ? 'Capacity unavailable'
                : breakdown
                  ? `Sampled ${relativeTime(breakdown.sampledAt, args.nowMs ?? Date.now())}`
                  : 'Capacity unavailable'
    const updateState = effectiveUpdateState(machine)
    return {
      id: machine.id,
      name: machine.name,
      hostname: machine.hostname,
      online: machine.online,
      availability,
      statusLabel: machine.online
        ? availability === 'unauthorized'
          ? 'online · view only'
          : 'online'
        : 'offline',
      memory: memoryHost ? hostMemoryView(memoryHost) : null,
      load: host ? hostLoadView(host, args.loadPerCore) : null,
      disk,
      capacityDetail,
      capacityLabel,
      sampledAt: breakdown?.sampledAt ?? host?.sampledAt ?? null,
      appVersion: machine.appVersion ?? null,
      targetVersion: machine.targetVersion ?? null,
      updateChannel: machine.updateChannel ?? null,
      updateState,
      updateLabel: machineUpdateLabel(machine, updateState),
    }
  })

  const onlineCount = machines.filter((machine) => machine.online).length
  const usableCount = machines.filter((machine) => machine.availability === 'available').length
  const currentCount = machines.filter((machine) => machine.updateState === 'current').length
  const behindCount = machines.filter((machine) => machine.updateState === 'behind').length
  const aheadCount = machines.filter((machine) => machine.updateState === 'ahead').length
  const unreportedCount = machines.filter(
    (machine) => machine.updateState === 'unreported' || machine.updateState === 'unknown',
  ).length
  const updateLabel =
    behindCount > 0
      ? `${behindCount} ${behindCount === 1 ? 'machine' : 'machines'} behind`
      : aheadCount > 0
        ? `${aheadCount} ${aheadCount === 1 ? 'machine' : 'machines'} ahead`
        : unreportedCount > 0
          ? `${unreportedCount} without a comparable build`
          : machines.length === 0
            ? 'No visible machines'
            : 'All visible machines current'

  return {
    machines,
    visibleCount: machines.length,
    onlineCount,
    usableCount,
    fleetLabel:
      machines.length === 0
        ? 'No visible machines'
        : `${onlineCount} of ${machines.length} visible ${machines.length === 1 ? 'machine' : 'machines'} online`,
    updateLabel,
    currentCount,
    behindCount,
    aheadCount,
    unreportedCount,
  }
}

export interface ConnectedDeviceView {
  sessionId: string
  name: string
  platform: string
  current: boolean
  activityLabel: string
  createdAt: string
  expiresAt: string
}

export function devicePlatformLabel(platform: MobileClientSession['platform']): string {
  if (platform === 'ios') return 'iOS'
  if (platform === 'android') return 'Android'
  if (platform === 'web') return 'Web'
  return 'Mobile'
}

/** Current device first, then most recently seen. The server has already cut
 * the population to the authenticated user; no user id is rendered or joined. */
export function connectedDeviceViews(
  sessions: readonly MobileClientSession[],
  nowMs: number,
): ConnectedDeviceView[] {
  return sessions
    .map((session) => ({
      sessionId: session.sessionId,
      name: session.deviceName,
      platform: devicePlatformLabel(session.platform),
      current: session.current,
      activityLabel: session.current
        ? 'This device · active now'
        : session.lastSeenAt
          ? `Active ${relativeTime(session.lastSeenAt, nowMs)}`
          : 'No activity reported',
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
    }))
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      return (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt)
    })
    .map(({ lastSeenAt: _lastSeenAt, ...view }) => view)
}
