import { workspaceFetch } from '@/lib/workspace-request'

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
 *
 * SPLIT HOSTING (PDM-34): where the UI is a separate origin, the public URL is
 * the API and has no `/mobile` page of its own — it only redirects to one. The
 * QR reads `appUrl` and points the phone at the app host in ONE hop. The
 * redirect stays as the fallback for clients too old to know about `appUrl`;
 * this is about not spending a round trip, and not showing a person an address
 * that is not where they end up.
 */

import { MOBILE_PROMO_DISMISSED_KEY } from '@podium/client-core/ui-state'
import { allTabIds, leafPaneIds } from '@podium/client-core/viewmodels'
import type { MobxPool } from '@podium/client-graph'
import {
  canonicalPodiumOrigin,
  formatPodiumLink,
  PODIUM_SCHEME,
  parsePodiumLink,
  parseServerVersion,
  podiumTargetPath,
} from '@podium/protocol'
import { useCallback, useEffect, useState } from 'react'
import { useRuntimeActions, useRuntimeLocal } from '@/app/keyed-runtime'
import type { Store } from '@/app/store'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { usePersistedUiState } from '@/lib/use-persisted-ui-state'

const HANDOFF_ORIGIN_PARAM = 'origin'
const HANDOFF_INSTANCE_PARAM = 'instance'
const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

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
  if (!canonicalOrigin || !sessionId || !INSTANCE_ID_PATTERN.test(instanceId)) {
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
 * canonical destination — the app host if the deployment has one, else the
 * configured public URL — or confirms that this client's server origin is the
 * fallback. A session change invalidates the old code before the next query.
 */
export function useMobileHandoffUrl(
  trpc: Store['trpc'] | undefined,
  httpOrigin: string | undefined,
  sessionId: string | null,
): string | null {
  const [published, setPublished] = useState<{
    trpc: Store['trpc']
    httpOrigin: string
    sessionId: string
    url: string
  } | null>(null)
  useEffect(() => {
    setPublished(null)
    if (!trpc || !httpOrigin || !sessionId) return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const [info, versionResponse] = await Promise.all([
          trpc.setup.info.query(undefined, { signal: controller.signal }),
          workspaceFetch(`${httpOrigin}/version`, {
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal,
          }),
        ])
        if (!versionResponse.ok) return
        const version = parseServerVersion(await versionResponse.json())
        if (cancelled) return
        const instanceId = version.instanceId
        if (typeof instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(instanceId)) return
        // `appUrl` first: under split hosting it is the host that actually
        // SERVES the page, and the public URL would only bounce the phone here
        // anyway (PDM-34).
        const configured =
          (typeof info.appUrl === 'string' && info.appUrl !== '' ? info.appUrl : '') ||
          (typeof info.publicUrl === 'string' && info.publicUrl !== '' ? info.publicUrl : '')
        const destinationOrigin = configured !== '' ? configured : httpOrigin
        const url = mobileHandoffUrl(destinationOrigin, instanceId, sessionId)
        if (!url) return
        setPublished({ trpc, httpOrigin, sessionId, url })
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
  // Hoisted before the comparison chain: narrowing an optional chain in the
  // first operand does not carry to the later ones, so reading the fields off
  // the union directly is a null dereference as far as the checker is
  // concerned (POD-1868).
  if (published === null) return null
  return published.trpc === trpc &&
    published.httpOrigin === httpOrigin &&
    published.sessionId === sessionId
    ? published.url
    : null
}

/** The session in the pane the operator is actively using. */
const FOCUS_ACTIONS = ['workspaceKey'] as const
export function useFocusedHandoffSessionId(): string | null {
  const { workspaceKey } = useRuntimeActions(FOCUS_ACTIONS)
  const workspaces = useRuntimeLocal('workspaces')
  const paneA = useRuntimeLocal('paneA'),
    paneB = useRuntimeLocal('paneB')
  const split = useRuntimeLocal('split'),
    focus = useRuntimeLocal('focusedPane')
  // Selection changes can resolve to a different existing layout.
  const selectedIssueId = useRuntimeLocal('selectedIssueId')
  const selectedWorktree = useRuntimeLocal('selectedWorktree')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed selection changes invalidate the stable engine resolver.
  const read = useCallback(() => {
    const layout = workspaces?.[workspaceKey()]
    if (!layout || allTabIds(layout).length === 0)
      return (split && focus === 'B' ? paneB : paneA) ?? null
    const visible = leafPaneIds(layout.root)
    const paneId = visible.includes(layout.focusedPaneId) ? layout.focusedPaneId : visible[0]
    return paneId === undefined ? null : (layout.panes[paneId]?.activeTabId ?? null)
  }, [workspaceKey, workspaces, paneA, paneB, split, focus, selectedIssueId, selectedWorktree])
  return useWorklistPoolProjection(read, null)
}

const readHasFirstTask = (pool: MobxPool): boolean => pool.hasFirstTask === true

export function useHasFirstTask(): boolean {
  return useWorklistPoolProjection(readHasFirstTask, false)
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
