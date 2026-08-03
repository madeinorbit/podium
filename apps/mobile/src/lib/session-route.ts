import type { Href } from 'expo-router'

/** Build a session link with an explicit return route that survives reloads. */
export function sessionHref(sessionId: string, backTo: string): Href {
  return {
    pathname: '/session/[sessionId]',
    params: { sessionId, backTo: safeSessionBackTarget(backTo) ?? '/' },
  } as Href
}

/** Only allow app-internal, non-session return routes from a URL parameter. */
export function sessionBackTarget(value: string | string[] | undefined): string {
  return parsedSessionBackTarget(value) ?? '/'
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
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/session/'))
    return undefined
  return value
}
