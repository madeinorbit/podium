import type { Href } from 'expo-router'
import { MOBILE_HOME } from './navigation'

/** Build a session link with an explicit return route that survives reloads. */
export function sessionHref(sessionId: string, backTo: string): Href {
  return {
    pathname: '/session/[sessionId]',
    params: { sessionId, backTo: safeSessionBackTarget(backTo) ?? MOBILE_HOME },
  } as Href
}

/** Only allow app-internal, non-session return routes from a URL parameter. */
export function sessionBackTarget(value: string | string[] | undefined): string {
  return parsedSessionBackTarget(value) ?? MOBILE_HOME
}

export function hasSessionBackTarget(value: string | string[] | undefined): boolean {
  return parsedSessionBackTarget(value) !== undefined
}

function parsedSessionBackTarget(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return undefined
  try {
    return safeSessionBackTarget(decodeURIComponent(raw))
  } catch {
    return undefined
  }
}

function safeSessionBackTarget(value: string): string | undefined {
  // Root used to be the Tray. Keep old notification/deep-link payloads valid,
  // but canonicalize their return target to the Work home.
  if (value === '/') return MOBILE_HOME
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/session/'))
    return undefined
  return value
}
