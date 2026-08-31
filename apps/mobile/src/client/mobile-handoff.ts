import { type PodiumTarget, canonicalPodiumOrigin, parsePodiumLink } from '@podium/protocol'
import type { ServerProfile } from './server-profiles'

const HANDOFF_ORIGIN_PARAM = 'origin'
const HANDOFF_INSTANCE_PARAM = 'instance'
const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export interface MobileHandoffDestination {
  origin: string
  instanceId: string
  sessionId: string
}

export type MobileHandoffRequest =
  | { kind: 'destination'; destination: MobileHandoffDestination }
  | { kind: 'unscoped' }

export interface PendingMobileHandoff {
  id: number
  request: MobileHandoffRequest | null
  profileSelected: boolean
}

let nextRequestId = 0
let pendingSnapshot: PendingMobileHandoff = { id: 0, request: null, profileSelected: false }
const pendingListeners = new Set<() => void>()

function publish(request: MobileHandoffRequest | null): void {
  pendingSnapshot = { id: ++nextRequestId, request, profileSelected: false }
  for (const listener of pendingListeners) listener()
}

/** A stable external-store seam keeps a handoff alive while profile/auth roots remount. */
export function subscribePendingMobileHandoff(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

export function pendingMobileHandoffSnapshot(): PendingMobileHandoff {
  return pendingSnapshot
}

/** Consume only the request the caller resolved, never a newer incoming link. */
export function consumePendingMobileHandoff(id: number): void {
  if (pendingSnapshot.id === id && pendingSnapshot.request !== null) publish(null)
}

/** A newer non-handoff intent retires every pending handoff generation. */
export function retirePendingMobileHandoff(): void {
  if (pendingSnapshot.request !== null) publish(null)
}

/** Release one exact generation to the authenticated host after profile selection settles. */
export function markPendingMobileHandoffProfileSelected(id: number): void {
  if (pendingSnapshot.id !== id || !pendingSnapshot.request || pendingSnapshot.profileSelected) {
    return
  }
  pendingSnapshot = { ...pendingSnapshot, profileSelected: true }
  for (const listener of pendingListeners) listener()
}

/**
 * Parse an OS-delivered app URL with the shared Podium address resolver. Pairing
 * links return null so their credential-scrubbing path remains the sole owner.
 */
export function parseMobileHandoffUrl(raw: string): MobileHandoffRequest | null {
  if (!/^podium:/i.test(raw.trim())) return null
  const link = parsePodiumLink(raw)
  if (link?.kind !== 'internal' || link.origin !== null) return null
  if (link.target.kind !== 'session' || link.target.hash) return { kind: 'unscoped' }

  const params = new URLSearchParams(link.target.search ?? '')
  const origins = params.getAll(HANDOFF_ORIGIN_PARAM)
  const instances = params.getAll(HANDOFF_INSTANCE_PARAM)
  const keys = [...params.keys()]
  const instanceId = instances[0]
  if (
    origins.length !== 1 ||
    instances.length !== 1 ||
    keys.length !== 2 ||
    !instanceId ||
    !INSTANCE_ID_PATTERN.test(instanceId) ||
    !link.target.session
  ) {
    return { kind: 'unscoped' }
  }
  const origin = canonicalPodiumOrigin(origins[0] ?? '')
  if (!origin || origin !== origins[0]) return { kind: 'unscoped' }
  return {
    kind: 'destination',
    destination: { origin, instanceId, sessionId: link.target.session },
  }
}

/**
 * Capture a native handoff without retaining its raw URL. The caller uses the
 * boolean to leave pairing links on the existing secret-scrubbing path.
 */
export function captureMobileHandoffUrl(raw: string): boolean {
  const request = parseMobileHandoffUrl(raw)
  if (!request) return false
  publish(request)
  return true
}

export type MobileHandoffFallbackReason =
  | 'identity-unverified'
  | 'profile-unavailable'
  | 'session-unavailable'
  | 'unscoped'

export type MobileHandoffDecision =
  | { kind: 'switch-profile'; profileId: string }
  | { kind: 'authenticate'; profileId: string }
  | { kind: 'wait-replica' }
  | { kind: 'open'; target: Extract<PodiumTarget, { kind: 'session' }> }
  | { kind: 'fallback'; reason: MobileHandoffFallbackReason }

export interface MobileHandoffContext {
  profiles: readonly ServerProfile[]
  activeProfileId: string
  activation: 'verified' | 'offline-cache'
  authentication: 'authenticated' | 'unauthenticated' | 'unavailable'
  authenticatedUserId?: string
  replicaReady: boolean
  sessions: readonly { sessionId: string }[]
}

/** Exact saved profile named by the credential-free handoff scope. */
export function matchingMobileHandoffProfile(
  request: Extract<MobileHandoffRequest, { kind: 'destination' }>,
  profiles: readonly ServerProfile[],
  activeProfileId: string | null,
): ServerProfile | null {
  const { destination } = request
  const matches = profiles.filter(
    (candidate) =>
      canonicalPodiumOrigin(candidate.httpOrigin) === destination.origin &&
      typeof candidate.instanceId === 'string' &&
      candidate.instanceId.length > 0 &&
      candidate.instanceId === destination.instanceId,
  )
  const active = matches.find((candidate) => candidate.id === activeProfileId)
  if (active) return active
  return matches.length === 1 ? (matches[0] ?? null) : null
}

/** Pure trust-boundary decision used by the native host and focused tests. */
export function decideMobileHandoff(
  request: MobileHandoffRequest,
  context: MobileHandoffContext,
): MobileHandoffDecision {
  if (request.kind === 'unscoped') return { kind: 'fallback', reason: 'unscoped' }
  const { destination } = request
  const profile = matchingMobileHandoffProfile(request, context.profiles, context.activeProfileId)
  if (!profile) return { kind: 'fallback', reason: 'profile-unavailable' }
  if (profile.id !== context.activeProfileId) {
    return { kind: 'switch-profile', profileId: profile.id }
  }
  if (context.activation !== 'verified') {
    return { kind: 'fallback', reason: 'identity-unverified' }
  }
  if (context.authentication === 'unavailable') {
    return { kind: 'fallback', reason: 'identity-unverified' }
  }
  if (context.authentication === 'unauthenticated') {
    return { kind: 'authenticate', profileId: profile.id }
  }
  if (profile.userId !== context.authenticatedUserId) {
    return { kind: 'fallback', reason: 'profile-unavailable' }
  }
  if (!context.replicaReady) return { kind: 'wait-replica' }
  if (!context.sessions.some((session) => session.sessionId === destination.sessionId)) {
    return { kind: 'fallback', reason: 'session-unavailable' }
  }
  return { kind: 'open', target: { kind: 'session', session: destination.sessionId } }
}

const FALLBACK_STATUS: Record<MobileHandoffFallbackReason, string> = {
  'identity-unverified': 'Opened Work because the saved server could not be verified.',
  'profile-unavailable': 'Opened Work because the matching saved server is unavailable.',
  'session-unavailable': 'Opened Work because this session is not available to this profile.',
  unscoped: 'Opened Work because this link does not identify a saved server.',
}

/** Fixed copy by reason. No inaccessible identifier can enter the status text. */
export function mobileHandoffFallbackStatus(reason: MobileHandoffFallbackReason): string {
  return FALLBACK_STATUS[reason]
}
