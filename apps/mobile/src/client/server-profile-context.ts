import type { ServerConfig } from '@podium/client-core/transport'
import { createContext, useContext } from 'react'
import type { ServerProfile } from './server-profiles'

/**
 * THE SERVER-PROFILE CONTEXT, SEPARATED FROM THE GATE THAT PROVIDES IT (POD-1429).
 *
 * These three pieces used to live in `./ServerProfileGate` beside the gate
 * itself, which imports `expo-router`, `expo-camera` and `expo-crypto` at module
 * scope in order to pair with a server. That made "read whatever profile is
 * already active" — a plain `useContext` call with no platform dependency at all
 * — reachable only by dragging the whole pairing flow in behind it. `ReadinessGate`
 * is the caller that pays for it: it runs BEFORE any of that and only wants the
 * config, yet its module graph could not be loaded without the native modules.
 *
 * `./ServerProfileGate` re-exports both hooks, so every existing import keeps
 * working. Same split, and for the same reason, as `./launch-ready`.
 */
export interface ServerProfileContextValue {
  profile: ServerProfile
  profiles: ServerProfile[]
  config: ServerConfig
  bearer: string | null
  runtimeKey: string
  isEphemeralOverride: boolean
  beginAddServer(): void
  switchProfile(profileId: string): Promise<void>
  renameProfile(profileId: string, name: string): Promise<void>
  removeProfile(profileId: string): Promise<void>
  updateCredential(bearer: string | null): Promise<void>
  recordUser(userId: string): Promise<void>
}

export const ServerProfileContext = createContext<ServerProfileContextValue | null>(null)

export function useServerProfile(): ServerProfileContextValue {
  const value = useContext(ServerProfileContext)
  if (!value) throw new Error('useServerProfile must be used inside ServerProfileGate')
  return value
}

/** Composition-root compatibility seam for isolated provider tests. */
export function useOptionalServerProfile(): ServerProfileContextValue | null {
  return useContext(ServerProfileContext)
}
