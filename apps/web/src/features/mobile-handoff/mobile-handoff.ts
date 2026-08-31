/**
 * MOBILE HANDOFF — the two surfaces that hand a desk session to a phone.
 *
 * Both surfaces emit the shared `podium:` session address understood by the
 * installed phone app. The scope is public server identity, not a credential;
 * pairing and its expiring secret remain owned by Connected devices.
 *
 * The QR carries the PUBLIC origin when the instance has one configured, never
 * `location.origin`: the packaged desktop page origin is not the server, and
 * the phone must match the exact saved server before opening the session.
 */

import { focusedPaneSession } from '@podium/client-core/engine'
import { MOBILE_PROMO_DISMISSED_KEY } from '@podium/client-core/ui-state'
import {
  PODIUM_SCHEME,
  canonicalPodiumOrigin,
  formatPodiumLink,
  parseServerVersion,
  parsePodiumLink,
  podiumTargetPath,
} from '@podium/protocol'
import { useEffect, useState } from 'react'
import { type Store, useReplicaIssues, useStoreSelector } from '@/app/store'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'

const HANDOFF_ORIGIN_PARAM = 'origin'
const HANDOFF_INSTANCE_PARAM = 'instance'
const MAX_INSTANCE_ID_LENGTH = 256

/**
 * A native app address containing only canonical server origin + instance
 * identity and the opaque session id. The shared protocol formatter and parser
 * own the address grammar; this feature only adds the server scope the phone
 * must verify before opening.
 */
export function mobileHandoffUrl(
  origin: string,
  instanceId: string,
  sessionId: string,
): string | null {
  const canonicalOrigin = canonicalPodiumOrigin(origin)
  if (
    !canonicalOrigin ||
    !sessionId ||
    instanceId.length === 0 ||
    instanceId.length > MAX_INSTANCE_ID_LENGTH
  ) {
    return null
  }
  const scope = new URLSearchParams({
    [HANDOFF_ORIGIN_PARAM]: canonicalOrigin,
    [HANDOFF_INSTANCE_PARAM]: instanceId,
  })
  const target = {
    kind: 'session',
    session: sessionId,
    search: `?${scope.toString()}`,
  } as const
  const href = formatPodiumLink(PODIUM_SCHEME, target)

  // Guard the QR boundary with the same grammar the phone will use. Comparing
  // canonical target paths also catches an accidental formatter change that
  // would drop or reinterpret the server scope.
  const parsed = parsePodiumLink(href)
  if (
    parsed?.kind !== 'internal' ||
    parsed.target.kind !== 'session' ||
    podiumTargetPath(parsed.target) !== podiumTargetPath(target)
  ) {
    return null
  }
  return href
}

/**
 * The URL a phone should open. It appears only after setup.info supplies the
 * canonical public origin, or confirms that this client's server origin is the
 * fallback. A session change invalidates the old code before the next query.
 */
export function useMobileHandoffUrl(
  trpc: Store['trpc'] | undefined,
  httpOrigin: string | undefined,
  sessionId: string | null,
): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!trpc || !httpOrigin || !sessionId) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const [info, versionResponse] = await Promise.all([
          trpc.setup.info.query(),
          fetch(`${httpOrigin}/version`, { credentials: 'omit', signal: controller.signal }),
        ])
        const version = parseServerVersion(await versionResponse.json())
        if (cancelled) return
        const instanceId = version.instanceId
        if (typeof instanceId !== 'string' || instanceId.length === 0) return
        const destinationOrigin =
          typeof info.publicUrl === 'string' && info.publicUrl !== '' ? info.publicUrl : httpOrigin
        setUrl(mobileHandoffUrl(destinationOrigin, instanceId, sessionId))
      } catch {
        // A destination without canonical server identity cannot be checked on
        // the phone. Hide the QR instead of minting a guess from the page URL.
      }
    }
    const controller = new AbortController()
    void load()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [httpOrigin, sessionId, trpc])
  return url
}

/** The session in the pane the operator is actively using. */
export function useFocusedHandoffSessionId(): string | null {
  return useStoreSelector((store) => {
    // Focused component tests intentionally expose only the fields their
    // subject reads. Treat those partial fixtures like a shell with no focused
    // session rather than making an unrelated handoff affordance throw.
    if (!Array.isArray(store.issues) || !store.workspaces || typeof store.workspaces !== 'object') {
      return null
    }
    return focusedPaneSession(store)
  })
}

/**
 * THE GATE, shared by both surfaces: one task has been created.
 *
 * Before that there is nothing on a phone to watch, so an invitation would be
 * an ad in a status bar. Deliberately "a task exists", not "a task is open" —
 * the pitch is about carrying work around, and a shell with work in it has
 * earned it whatever state that work is in.
 */
export function useHasFirstTask(): boolean {
  const issues = useReplicaIssues()
  return issues.some((issue) => !issue.deletedAt)
}

const parseDismissed = (raw: string | null): boolean => raw === 'true'
/** `null` deletes the row, so "not dismissed" leaves nothing behind. */
const serializeDismissed = (value: boolean): string | null => (value ? 'true' : null)

/**
 * Has the promo card been turned down? Replicated, so the answer follows the
 * person to the next browser rather than being re-asked on every device.
 */
export function useMobilePromoDismissed(): [boolean, (next: boolean) => void] {
  return usePersistedUiState(MOBILE_PROMO_DISMISSED_KEY, parseDismissed, serializeDismissed)
}
