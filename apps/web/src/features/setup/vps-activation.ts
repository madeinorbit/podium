import type { ActivationRoute } from './activation-route'

export const VPS_ACTIVATION_VERSION = 2 as const
export const VPS_ACTIVATION_ROUTES = ['vps-intro'] as const

export type VpsActivationRoute = (typeof VPS_ACTIVATION_ROUTES)[number]
export type VpsReturnRoute = 'welcome' | 'local-project'

/**
 * Durable progress for fresh VPS onboarding. The VPS is a new authority, not a transfer target,
 * so the checkpoint owns only where Back returns. Installation state lives on the VPS itself and
 * the typed URL draft is device-local.
 */
export interface VpsActivationState {
  version: typeof VPS_ACTIVATION_VERSION
  route: VpsActivationRoute
  returnRoute: VpsReturnRoute
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
  }
}

function isReturnRoute(value: unknown): value is VpsReturnRoute {
  return value === 'welcome' || value === 'local-project'
}

/** Parse current state and safely collapse legacy pairing/transfer checkpoints to fresh setup. */
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
  if (!isReturnRoute(row.returnRoute)) return null

  if (row.version === VPS_ACTIVATION_VERSION && row.route === 'vps-intro') {
    return { version: VPS_ACTIVATION_VERSION, route: 'vps-intro', returnRoute: row.returnRoute }
  }

  // Version 1 represented the superseded "pair locally, then transfer" onboarding flow.
  if (
    row.version === 1 &&
    (row.route === 'vps-intro' || row.route === 'vps-pairing' || row.route === 'vps-transfer')
  ) {
    return vpsIntroState(row.returnRoute)
  }
  return null
}

export function parseVpsActivation(raw: string | null): VpsActivationState | null {
  return parseVpsActivationValue(raw)
}

export function serializeVpsActivation(state: VpsActivationState): string {
  return JSON.stringify(state)
}

export function vpsIntroState(returnRoute: VpsReturnRoute): VpsActivationState {
  return { version: VPS_ACTIVATION_VERSION, route: 'vps-intro', returnRoute }
}
