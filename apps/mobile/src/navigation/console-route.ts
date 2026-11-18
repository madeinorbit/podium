import type { PodiumTarget } from '@podium/protocol'

/** Console links resolve their session through the same shared reader as chat. */
export function consoleSessionTarget(
  target: PodiumTarget,
): Extract<PodiumTarget, { kind: 'session' }> | null {
  if (target.kind !== 'view' || target.search || target.hash) return null
  const match = /^\/sessions?\/([^/]+)\/terminal\/?$/.exec(target.path)
  if (!match?.[1]) return null
  try {
    const session = decodeURIComponent(match[1])
    return session ? { kind: 'session', session } : null
  } catch {
    return null
  }
}

export function consoleRoute(route: string, target: PodiumTarget): string {
  return consoleSessionTarget(target) ? `${route}/terminal` : route
}
