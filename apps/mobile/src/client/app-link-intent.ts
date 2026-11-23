import { parsePodiumLink } from '@podium/protocol'
import { MOBILE_HOME } from '../lib/navigation'
import { parseMobileHandoffUrl } from './mobile-handoff'
import { isPairingSystemPath } from './pairing-intent'

/**
 * Credential-bearing app links the profile gate consumes itself (POD-2364).
 *
 * `podium://pair…` carries a one-time pairing secret and `podium://signed-in…`
 * a sign-in code. expo-router must never route them: there is no screen to
 * show, so it rendered Unmatched Route over the pairing setup, and its router
 * state would hold the secret. Both spellings iOS delivers count, the normal
 * `podium://pair?…` and the collapsed `podium:///pair?…`.
 */
const GATE_OWNED_HEADS = new Set(['pair', 'signed-in'])

export function isGateOwnedAppLink(raw: string): boolean {
  // The HTTPS fragment form (`…/mobile#pair=…`) and every custom-scheme
  // spelling of a pairing link (POD-6913).
  if (isPairingSystemPath(raw)) return true
  const match = /^podium:\/\/([^/?#]*)\/*([^/?#]*)/i.exec(raw.trim())
  if (!match) return false
  const head = (match[1] || match[2] || '').toLowerCase()
  return GATE_OWNED_HEADS.has(head)
}

/** Native mission links use the same chat/deck routes as an in-app row tap. */
export function nativeMissionHref(raw: string): string | null {
  const link = parsePodiumLink(raw)
  if (link?.kind !== 'internal' || link.origin !== null || link.target.kind !== 'view') return null
  const { path, search, hash } = link.target
  const match = /^\/mission\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path)
  if (!match || hash) return null
  const params = new URLSearchParams(search)
  if ([...params.keys()].some((key) => key !== 'sessionId')) return null
  if (params.getAll('sessionId').length > 1) return null
  try {
    const missionId = decodeURIComponent(match[1] ?? '')
    const tail = match[2] ? decodeURIComponent(match[2]) : undefined
    const deck = tail === 'details'
    const sessionId = deck ? params.get('sessionId') : (tail ?? params.get('sessionId'))
    if (!missionId || sessionId === '') return null
    return `/mission/${encodeURIComponent(missionId)}${deck ? '/details' : ''}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`
  } catch {
    return null
  }
}

/** One owner per native URL: mission routes go to Expo, handoffs to the host. */
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string
  initial: boolean
}): string | null {
  if (isGateOwnedAppLink(path)) return '/'
  const mission = nativeMissionHref(path)
  if (mission) return mission
  // The profile gate reads the original OS URL and the authenticated host
  // pushes its resolved route. Do not also navigate for the same warm event.
  if (parseMobileHandoffUrl(path)) return initial ? MOBILE_HOME : null
  return path
}
