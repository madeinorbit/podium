import { routeForSystemPath } from '../src/client/pairing-intent'

/**
 * Rewrites every OS-delivered link before expo-router resolves it (native
 * only). Pairing links never reach a route: the profile gate owns them through
 * `Linking` (POD-6913). See ../src/client/pairing-intent.
 */
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string
  initial: boolean
}): string | null {
  return routeForSystemPath(path, initial)
}
