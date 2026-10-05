import type { MainView } from '@podium/client-core/ui-state'
import { observer } from '@podium/client-graph/react'
import type { ArtifactId } from '@podium/model/browser'
import { type PodiumTarget, podiumTargetPath } from '@podium/protocol'
import { useEffect, useRef, useState } from 'react'
import { useShellActions, useShellLinks } from '@/app/shell-data'
import {
  activatePodiumHref,
  canonicalizePodiumAnchors,
  classifyPodiumLink,
  hasServerSelector,
  hasUnsupportedTypedDetail,
  PODIUM_NATIVE_OPEN_EVENT,
  setKnownPodiumOrigins,
  setPodiumTargetActivator,
  systemBrowserPodiumHref,
} from '@/lib/podium-link'
import { handlePodiumLinkAuxClick, handlePodiumLinkContextMenu } from '@/lib/podium-link-click'
import { resolvePodiumTarget } from '@/lib/podium-link-open'

export const PODIUM_LINK_RESOLUTION_TIMEOUT_MS = 5_000
export const PODIUM_LINK_QUEUE_CAPACITY = 32

interface PendingPodiumHref {
  href: string
  target: PodiumTarget | null
  expiresAt: number | null
  acknowledge: () => void
  nativeOwned: boolean
}

function pendingPodiumHref(
  href: string,
  acknowledge = (): void => {},
  nativeOwned = false,
): PendingPodiumHref {
  const link = classifyPodiumLink(href)
  return { href, target: link?.kind === 'internal' ? link.target : null, expiresAt: null, acknowledge, nativeOwned }
}

/**
 * Makes Podium addresses live in this tab (POD-1606). The page-local native
 * bridge owns accepted work across host remounts; this component acknowledges
 * a URL only after activation or finite expiry. It renders nothing.
 *
 * TWO REGISTRATIONS, BOTH OF WHICH ONLY THIS LAYER KNOWS:
 *
 *  - WHICH ORIGINS ARE US. `httpOrigin` is the server this client is actually
 *    talking to, which in the packaged macOS app is NOT the page origin — that
 *    mismatch is the whole bug. Registering it is what lets the markdown
 *    pipeline and the offer renderer recognise a link home.
 *  - HOW TO OPEN ONE. Issues and sessions navigate; artifacts and files open as
 *    tabs through the store actions that already exist. Read current rows on
 *    activation, and observe them while a cold URL awaits resolution.
 */
function PodiumLinkHostView({
  initialHref = null,
  onInitialHrefConsumed,
  replicaReady = true,
}: {
  initialHref?: string | null
  onInitialHrefConsumed?: () => void
  replicaReady?: boolean
}): null {
  const {
    httpOrigin,
    setOpenIssueId,
    setView,
    navigateToSession,
    openArtifact,
    openFileInWorktree,
  } = useShellActions()
  const { readIssue, readSession, artifactIssue } = useShellLinks()
  // Manifests use the existing batched loader. A click accepted while its row
  // is cold is retried locally; native URLs retain their acknowledgement queue.
  const [artifactDemands, setArtifactDemands] = useState<
    readonly { id: string; expiresAt: number }[]
  >([])
  const demandedArtifacts = artifactDemands.map((demand) => artifactIssue(demand.id))
  const nativeResolution = useRef(false)
  const browserArtifacts = useRef<{ target: PodiumTarget; expiresAt: number }[]>([])
  const pendingHrefs = useRef<PendingPodiumHref[]>(
    initialHref ? [pendingPodiumHref(initialHref, () => onInitialHrefConsumed?.())] : [],
  )
  const [pendingRevision, setPendingRevision] = useState(0)
  // MobX subscriptions belong to render. Only the FIFO head and accepted
  // browser artifact targets demand data; file/view/unsupported URLs do not.
  const head = pendingHrefs.current[0]
  const observeTarget = (target: PodiumTarget | null) => {
    if (!target || hasUnsupportedTypedDetail(target)) return undefined
    if (target.kind === 'session') return readSession(target.session)
    if (target.kind === 'issue') return readIssue(target.issue)
    if (target.kind !== 'artifact') return undefined
    const issue = readIssue(target.issue)
    return issue ? artifactIssue(issue.id) : undefined
  }
  const headRow = observeTarget(head?.target ?? null)
  const browserRows = browserArtifacts.current.map(pending => observeTarget(pending.target))

  useEffect(() => {
    setKnownPodiumOrigins(httpOrigin ? [httpOrigin] : [])
    if (httpOrigin) canonicalizePodiumAnchors(document)
    const pending = pendingHrefs.current[0]
    if (pending && !pending.target) {
      const link = classifyPodiumLink(pending.href)
      if (link?.kind === 'internal') {
        pending.target = link.target
        setPendingRevision(value => value + 1)
      }
    }
  }, [httpOrigin])

  // Middle-click and context menus do not dispatch an ordinary click. The
  // shared handlers canonicalize browser fallbacks and cover the packaged
  // shell's narrower interaction contract without opening on menu display.
  useEffect(() => {
    const onAuxClick = (event: MouseEvent): void => {
      handlePodiumLinkAuxClick(event)
    }
    const onContextMenu = (event: MouseEvent): void => {
      handlePodiumLinkContextMenu(event)
    }
    document.addEventListener('auxclick', onAuxClick, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      document.removeEventListener('auxclick', onAuxClick, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
    }
  }, [])

  useEffect(() => {
    setPodiumTargetActivator((target) => {
      if (hasUnsupportedTypedDetail(target)) return false
      let artifactTarget: ReturnType<typeof artifactIssue>
      if (target.kind === 'artifact') {
        const linked = readIssue(target.issue)
        const full = linked ? artifactIssue(linked.id) : undefined
        if (linked && !full) {
          if (artifactDemands.length >= PODIUM_LINK_QUEUE_CAPACITY * 2) return false
          setArtifactDemands((demands) =>
            demands.some((demand) => demand.id === linked.id)
              ? demands
              : [
                  ...demands,
                  {
                    id: linked.id,
                    expiresAt: Date.now() + PODIUM_LINK_RESOLUTION_TIMEOUT_MS,
                  },
                ],
          )
          if (nativeResolution.current) return false
          if (browserArtifacts.current.length >= PODIUM_LINK_QUEUE_CAPACITY) return false
          browserArtifacts.current.push({
            target,
            expiresAt: Date.now() + PODIUM_LINK_RESOLUTION_TIMEOUT_MS,
          })
          return true
        }
        artifactTarget = full
      }
      const open = resolvePodiumTarget(target, {
        issue: target.kind === 'artifact' ? () => artifactTarget : readIssue,
        session: readSession,
      })
      // FALSE, NOT SILENCE. Everything below reports whether it opened
      // something; the caller cancels the anchor only on true, so an address
      // this client cannot answer falls back to an ordinary navigation.
      if (!open) return false
      switch (open.kind) {
        case 'issue':
          setOpenIssueId(open.issueId)
          setView('issues')
          return true
        case 'session':
          navigateToSession(open.sessionIdOrRef)
          return true
        case 'artifact':
          openArtifact({
            issueId: open.issueId,
            artifactId: open.artifactId as ArtifactId,
            path: open.path,
            ...(open.worktreePath ? { worktreePath: open.worktreePath } : {}),
          })
          return true
        case 'file':
          openFileInWorktree({
            root: open.root,
            path: open.path,
            ...(open.machineId ? { machineId: open.machineId } : {}),
          })
          return true
        default: {
          // A plain page, and only the ones this build actually routes. A
          // backend path on our own origin (/files/asset, /trpc/…) and a repo
          // file (/docs/readme.md) both land here, and both need the anchor.
          //
          // Detailed view addresses were already declined by the pure resolver:
          // setView cannot preserve their query or fragment. Only a lossless
          // top-level view reaches this branch.
          const view = mainViewForPath(open.path)
          if (!view) return false
          setView(view)
          return true
        }
      }
    })
    return () => setPodiumTargetActivator(null)
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry addressed targets when demand or pending rows change.
  useEffect(() => {
    const waiting = browserArtifacts.current
    if (!waiting.length) return
    let deadline = Infinity
    let removed = false
    for (const pending of [...waiting]) {
      const issue =
        pending.target.kind === 'artifact'
          ? readIssue(pending.target.issue)
          : undefined
      const full = issue ? artifactIssue(issue.id) : undefined
      if (!full && pending.expiresAt > Date.now()) {
        deadline = Math.min(deadline, pending.expiresAt)
        continue
      }
      waiting.splice(waiting.indexOf(pending), 1)
      removed = true
      const href = podiumTargetPath(pending.target)
      // A missing manifest has the same browser fallback as a resident invalid
      // link, rather than disappearing after we accepted its initial click.
      nativeResolution.current = true
      let activated: boolean
      try {
        activated = activatePodiumHref(href)
      } finally {
        nativeResolution.current = false
      }
      if (!activated) window.location.assign(systemBrowserPodiumHref(href) ?? href)
    }
    if (removed) setPendingRevision(value => value + 1)
    if (Number.isFinite(deadline)) {
      const retry = window.setTimeout(
        () => setPendingRevision((value) => value + 1),
        Math.max(0, deadline - Date.now()),
      )
      return () => window.clearTimeout(retry)
    }
  }, [browserRows, demandedArtifacts, pendingRevision, artifactIssue])

  // Startup addresses are captured before createRouter can normalize its
  // unknown path to /workspace. Keep retrying while replica rows arrive: refs,
  // sessions and artifact panel entries all need live data to resolve. Stop at
  // an unresolved head so a later URL cannot overtake it and become the wrong
  // final destination. An unavailable target expires after a bounded wait so
  // untrusted input cannot wedge every later native activation. The deadline
  // begins only after the initial replica is ready: cold data transfer can take
  // longer than the eviction window without making a valid target look absent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry pending startup targets after pool publications.
  useEffect(() => {
    if (!replicaReady) return
    const now = Date.now()
    let advanced = false
    for (const pending of pendingHrefs.current) {
      pending.expiresAt ??= now + PODIUM_LINK_RESOLUTION_TIMEOUT_MS
    }
    while (pendingHrefs.current.length > 0) {
      const pending = pendingHrefs.current[0]
      if (pending === undefined) break
      nativeResolution.current = true
      let activated: boolean
      try {
        activated = activatePodiumHref(pending.href)
      } finally {
        nativeResolution.current = false
      }
      if (activated || (pending.expiresAt !== null && pending.expiresAt <= now)) {
        pendingHrefs.current.shift()
        pending.acknowledge()
        advanced = true
        continue
      }
      if (pending.expiresAt === null) return
      // The next cold head needs its own render subscription, even when the
      // effect stops before the queue becomes empty.
      if (advanced) setPendingRevision(value => value + 1)
      const retry = window.setTimeout(
        () => setPendingRevision((value) => value + 1),
        pending.expiresAt - now,
      )
      return () => window.clearTimeout(retry)
    }
    if (advanced) setPendingRevision((value) => value + 1)
  }, [headRow, pendingRevision, replicaReady, demandedArtifacts])

  useEffect(() => {
    const now = Date.now()
    const waiting = artifactDemands.filter(
      (demand, index) => !demandedArtifacts[index] && demand.expiresAt > now,
    )
    if (waiting.length !== artifactDemands.length) {
      setArtifactDemands(waiting)
      return
    }
    if (!waiting.length) return
    const deadline = Math.min(...waiting.map((demand) => demand.expiresAt))
    const retry = window.setTimeout(
      () =>
        setArtifactDemands((demands) => demands.filter((demand) => demand.expiresAt > Date.now())),
      Math.max(0, deadline - now),
    )
    return () => window.clearTimeout(retry)
  }, [artifactDemands, demandedArtifacts])

  // Native capture and window focus belong to POD-1710. This is the narrow web
  // half of that contract: one raw URL event, validated and routed through the
  // same resolver as every rendered link. No native-specific parser lives here.
  useEffect(() => {
    const nativeBridge = globalThis as {
      __PODIUM_NATIVE_OPEN_READY__?: (ready?: boolean) => void
      __PODIUM_NATIVE_OPEN_ACK__?: (raw: string) => void
    }
    const onNativeOpen = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      if (typeof detail !== 'string') return
      const nativeOwned = typeof nativeBridge.__PODIUM_NATIVE_OPEN_ACK__ === 'function'
      const acknowledge = (): void => nativeBridge.__PODIUM_NATIVE_OPEN_ACK__?.(detail)
      const link = classifyPodiumLink(detail)
      if (
        link?.kind !== 'internal' ||
        hasServerSelector(detail) ||
        hasUnsupportedTypedDetail(link.target)
      ) {
        acknowledge()
        return
      }
      // React StrictMode replays effects without discarding refs. READY(false)
      // deliberately makes the page resend its unacknowledged head, so retain
      // the first local claim instead of queueing that same in-flight work twice.
      if (
        nativeOwned &&
        pendingHrefs.current.some((pending) => pending.nativeOwned && pending.href === detail)
      ) {
        return
      }
      if (pendingHrefs.current.length >= PODIUM_LINK_QUEUE_CAPACITY) {
        acknowledge()
        return
      }
      pendingHrefs.current.push(pendingPodiumHref(detail, acknowledge, nativeOwned))
      setPendingRevision((value) => value + 1)
    }
    window.addEventListener(PODIUM_NATIVE_OPEN_EVENT, onNativeOpen)
    nativeBridge.__PODIUM_NATIVE_OPEN_READY__?.(true)
    return () => {
      nativeBridge.__PODIUM_NATIVE_OPEN_READY__?.(false)
      window.removeEventListener(PODIUM_NATIVE_OPEN_EVENT, onNativeOpen)
    }
  }, [])

  return null
}

const PoolPodiumLinkHost = observer(PodiumLinkHostView)
export function PodiumLinkHost(props: Parameters<typeof PodiumLinkHostView>[0]) {
  const Surface = PoolPodiumLinkHost
  return <Surface {...props} />
}

/** The one view this build would show for a plain in-app path, or null when it
 *  has none — which is the answer for every backend route and every file the
 *  server serves outside the SPA. */
function mainViewForPath(path: string): MainView | null {
  const segments = path.split('/').filter(Boolean)
  if (segments.length > 1) return null
  const head = segments[0]
  if (head === undefined) return 'workspace'
  if (head === 'workspace') return 'workspace'
  if (head === 'settings') return 'settings'
  if (head === 'issues') return 'issues'
  if (head === 'usage' || head === 'automations' || head === 'specs' || head === 'workflows') {
    return head
  }
  return null
}
