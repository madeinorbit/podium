import { asMachineId, type MachineId } from '@podium/model'
import { ACTIVATION_ROUTE_PARAM, type ActivationRoute } from './activation-route'

export const VPS_ACTIVATION_VERSION = 1 as const

export const VPS_ACTIVATION_ROUTES = ['vps-intro', 'vps-pairing', 'vps-transfer'] as const

export type VpsActivationRoute = (typeof VPS_ACTIVATION_ROUTES)[number]
export type VpsReturnRoute = 'welcome' | 'local-project'

export interface VpsActivationTarget {
  machineId: MachineId
  name: string
  /** The destination origin is persisted before transfer so a web client can resume there. */
  publicUrl?: string
}

/**
 * Server-replicated progress for the assisted VPS lane.
 *
 * Pairing credentials are deliberately absent: they expire and must be re-minted after a reload.
 * The machine baseline is durable so a VPS that connects while this browser is closed is still
 * recognised as the newly paired target when activation resumes.
 */
export interface VpsActivationState {
  version: typeof VPS_ACTIVATION_VERSION
  route: VpsActivationRoute
  returnRoute: VpsReturnRoute
  baselineMachineIds: MachineId[]
  moveServer: boolean
  target?: VpsActivationTarget
}

/** Build a direct pairing checkpoint after the overview has explained the topology. */
export function startVpsPairingState(
  returnRoute: VpsReturnRoute,
  baselineMachineIds: MachineId[],
): VpsActivationState {
  return vpsPairingState(vpsIntroState(returnRoute), baselineMachineIds, true)
}

export function isVpsActivationRoute(route: ActivationRoute): route is VpsActivationRoute {
  return (VPS_ACTIVATION_ROUTES as readonly string[]).includes(route)
}

export function activationRouteLabel(route: ActivationRoute): string {
  switch (route) {
    case 'welcome':
      return 'welcome'
    case 'local-project':
      return 'local projects'
    case 'agent':
      return 'agent readiness'
    case 'first-task':
      return 'your first task draft'
    case 'existing-podium':
      return 'existing Podium setup'
    case 'existing-client':
      return 'remote client connection'
    case 'existing-machine':
      return 'machine connection'
    case 'vps-intro':
      return 'always-on VPS setup'
    case 'vps-pairing':
      return 'VPS pairing'
    case 'vps-transfer':
      return 'server transfer'
  }
}

function isReturnRoute(value: unknown): value is VpsReturnRoute {
  return value === 'welcome' || value === 'local-project'
}

function isVpsRoute(value: unknown): value is VpsActivationRoute {
  return typeof value === 'string' && (VPS_ACTIVATION_ROUTES as readonly string[]).includes(value)
}

/** Parse a layout value without allowing stale/future schemas to strand activation. */
export function parseVpsActivationValue(value: unknown): VpsActivationState | null {
  let candidate = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return null
    }
  }
  if (!candidate || typeof candidate !== 'object') return null
  const row = candidate as Record<string, unknown>
  if (
    row.version !== VPS_ACTIVATION_VERSION ||
    !isVpsRoute(row.route) ||
    !isReturnRoute(row.returnRoute) ||
    typeof row.moveServer !== 'boolean' ||
    !Array.isArray(row.baselineMachineIds) ||
    row.baselineMachineIds.length > 512 ||
    row.baselineMachineIds.some(
      (id) => typeof id !== 'string' || id.length === 0 || id.length > 256,
    )
  ) {
    return null
  }

  let target: VpsActivationTarget | undefined
  if (row.target !== undefined) {
    if (!row.target || typeof row.target !== 'object') return null
    const targetRow = row.target as Record<string, unknown>
    if (
      typeof targetRow.machineId !== 'string' ||
      targetRow.machineId.length === 0 ||
      targetRow.machineId.length > 256 ||
      typeof targetRow.name !== 'string' ||
      targetRow.name.length === 0 ||
      targetRow.name.length > 256 ||
      (targetRow.publicUrl !== undefined &&
        (typeof targetRow.publicUrl !== 'string' || targetRow.publicUrl.length > 2_048))
    ) {
      return null
    }
    target = {
      machineId: asMachineId(targetRow.machineId),
      name: targetRow.name,
      ...(typeof targetRow.publicUrl === 'string' ? { publicUrl: targetRow.publicUrl } : {}),
    }
  }
  if (row.route === 'vps-transfer' && !target) return null

  return {
    version: VPS_ACTIVATION_VERSION,
    route: row.route,
    returnRoute: row.returnRoute,
    baselineMachineIds: row.baselineMachineIds.map(asMachineId),
    moveServer: row.moveServer,
    ...(target ? { target } : {}),
  }
}

export function parseVpsActivation(raw: string | null): VpsActivationState | null {
  return parseVpsActivationValue(raw)
}

export function serializeVpsActivation(state: VpsActivationState): string {
  return JSON.stringify(state)
}

export function vpsIntroState(returnRoute: VpsReturnRoute): VpsActivationState {
  return {
    version: VPS_ACTIVATION_VERSION,
    route: 'vps-intro',
    returnRoute,
    baselineMachineIds: [],
    moveServer: true,
  }
}

export function vpsPairingState(
  previous: VpsActivationState,
  baselineMachineIds: readonly MachineId[],
  moveServer = previous.moveServer,
): VpsActivationState {
  return {
    ...previous,
    route: 'vps-pairing',
    baselineMachineIds: [...baselineMachineIds],
    moveServer,
    target: undefined,
  }
}

export function vpsTransferState(
  previous: VpsActivationState,
  target: VpsActivationTarget,
): VpsActivationState {
  return { ...previous, route: 'vps-transfer', target }
}

/** Destination link for web clients; login may happen there before this route reconstructs. */
export function vpsDestinationUrl(publicUrl: string): string | null {
  try {
    const destination = new URL(publicUrl)
    if (destination.protocol !== 'http:' && destination.protocol !== 'https:') return null
    if (destination.username || destination.password) return null
    destination.pathname = '/workspace'
    destination.search = ''
    destination.searchParams.set(ACTIVATION_ROUTE_PARAM, 'vps-transfer')
    destination.hash = ''
    return destination.toString()
  } catch {
    return null
  }
}

export function isDestinationOrigin(publicUrl: string, origin: string): boolean {
  try {
    return new URL(publicUrl).origin === origin
  } catch {
    return false
  }
}
