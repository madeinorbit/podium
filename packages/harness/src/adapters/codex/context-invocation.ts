import type { HarnessObserveInput, HarnessObserverHost } from '../../manifest.js'
import { nativeTime, text } from './context-native.js'

/** Adapter-local metadata, not a fabricated native session_meta record. Only
 * this observer's cursor can carry it; a transcript cannot choose that cursor. */
export const CODEX_INVOCATION = 'podium-codex-invocation'
export const CODEX_INVOCATION_SEGMENT = 'codex-invocation'

/** startedAtMs is supplied only for a fresh spawn. Rebuilt reattach inventory
 * and createdAtMs do not witness the binary that wrote historical records.
 * This piggybacks the existing observer; it opens no reader/process or timer. */
export function codexInvocationPublisher(input: HarnessObserveInput, host: HarnessObserverHost) {
  const installation = input.harnessContext?.installation
  const rawVersion = installation?.kind === 'codex' ? text(installation.version)?.trim() : undefined
  // The inventory retains stdout, including the native CLI prefix.
  const version = rawVersion && /^(?:codex-cli\s+)?(\d+\.\d+\.\d+)$/.exec(rawVersion)?.[1]
  const startedAt = nativeTime(input.startedAtMs)
  let published: string | undefined
  return (nativeSessionId: string): void => {
    const identity = host.contextIdentity?.()
    if (!version || !startedAt || !identity || !host.onContextPayload) return
    const key = `${nativeSessionId}:${identity.observerGeneration}:${identity.turnEpoch}`
    if (key === published) return
    published = key
    host.onContextPayload(
      { type: CODEX_INVOCATION, nativeSessionId, version, startedAt },
      {
        ...identity,
        at: startedAt,
        provenance: 'live',
        cursor: {
          segmentId: CODEX_INVOCATION_SEGMENT,
          components: { spawn: Date.parse(startedAt) },
        },
      },
    )
  }
}
