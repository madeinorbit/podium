import { observer } from 'mobx-react-lite'
import type { MainView } from '@podium/client-core/ui-state'
import type { ArtifactId } from '@podium/model/browser'
import { podiumTargetPath, type PodiumTarget } from '@podium/protocol'
import { useEffect, useRef, useState } from 'react'
import { useShellActions, useShellLinks } from '@/app/shell-data'
import {
  PODIUM_NATIVE_OPEN_EVENT,
  activatePodiumHref,
  canonicalizePodiumAnchors,
  classifyPodiumLink,
  hasServerSelector,
  hasUnsupportedTypedDetail,
  setKnownPodiumOrigins,
  setPodiumTargetActivator,
  systemBrowserPodiumHref,
} from '@/lib/podium-link'
import {
  handlePodiumLinkAuxClick,
  handlePodiumLinkContextMenu,
} from '@/lib/podium-link-click'
import { findLinkedIssue, resolvePodiumTarget } from '@/lib/podium-link-open'

export const PODIUM_LINK_RESOLUTION_TIMEOUT_MS = 5_000
export const PODIUM_LINK_QUEUE_CAPACITY = 32

interface PendingPodiumHref {
  href: string
  expiresAt: number | null
  acknowledge: () => void
  nativeOwned: boolean
}

function pendingPodiumHref(
  href: string,
  acknowledge = (): void => {},
  nativeOwned = false,
): PendingPodiumHref {
  return { href, expiresAt: null, acknowledge, nativeOwned }
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
 *    tabs through the store actions that already exist. Re-registered on every
 *    render so the activator always closes over the current issue rows —
 *    resolving `POD-1606` needs live data, exactly like the ref activator.
 */
export const PodiumLinkHost = observer(function PodiumLinkHost({
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
  const { issues, sessions, artifactIssue } = useShellLinks()
  // Manifests use the existing batched loader. A click accepted while its row
  // is cold is retried locally; native URLs retain their acknowledgement queue.
  const [artifactDemands, setArtifactDemands] = useState<readonly string[]>([])
  const demandedArtifacts = artifactDemands.map(artifactIssue)
  const nativeResolution = useRef(false)
  const browserArtifacts = useRef<{ target: PodiumTarget; expiresAt: number }[]>([])
  const pendingHrefs = useRef<PendingPodiumHref[]>(
    initialHref ? [pendingPodiumHref(initialHref, () => onInitialHrefConsumed?.())] : [],
  )
  const [pendingRevision, setPendingRevision] = useState(0)

  useEffect(() => {
    setKnownPodiumOrigins(httpOrigin ? [httpOrigin] : [])
    if (httpOrigin) canonicalizePodiumAnchors(document)
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
      let targets = issues
      if (target.kind === 'artifact') {
        const linked = findLinkedIssue(target.issue, issues)
        const full = linked ? artifactIssue(linked.id) : undefined
        if (linked && !full) {
          setArtifactDemands(ids => ids.includes(linked.id) ? ids : [...ids, linked.id])
          if (nativeResolution.current) return false
          if (browserArtifacts.current.length >= PODIUM_LINK_QUEUE_CAPACITY) return false
          browserArtifacts.current.push({ target, expiresAt: Date.now() + PODIUM_LINK_RESOLUTION_TIMEOUT_MS })
          return true
        }
        if (full) targets = [full]
      }
      const open = resolvePodiumTarget(target, { issues: targets, sessions })
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

  useEffect(() => {
    const waiting = browserArtifacts.current
    if (!waiting.length) return
    let deadline = Infinity
    for (const pending of [...waiting]) {
      const issue = pending.target.kind === 'artifact' ? findLinkedIssue(pending.target.issue, issues) : undefined
      const full = issue ? artifactIssue(issue.id) : undefined
      if (!full && pending.expiresAt > Date.now()) { deadline = Math.min(deadline, pending.expiresAt); continue }
      waiting.splice(waiting.indexOf(pending), 1)
      const href = podiumTargetPath(pending.target)
      // A missing manifest has the same browser fallback as a resident invalid
      // link, rather than disappearing after we accepted its initial click.
      nativeResolution.current = true
      let activated: boolean
      try { activated = activatePodiumHref(href) } finally { nativeResolution.current = false }
      if (!activated) window.location.assign(systemBrowserPodiumHref(href) ?? href)
    }
    if (Number.isFinite(deadline)) {
      const retry = window.setTimeout(() => setPendingRevision(value => value + 1), Math.max(0, deadline - Date.now()))
      return () => window.clearTimeout(retry)
    }
  }, [issues, demandedArtifacts, pendingRevision, artifactIssue])

  // Startup addresses are captured before createRouter can normalize its
  // unknown path to /workspace. Keep retrying while replica rows arrive: refs,
  // sessions and artifact panel entries all need live data to resolve. Stop at
  // an unresolved head so a later URL cannot overtake it and become the wrong
  // final destination. An unavailable target expires after a bounded wait so
  // untrusted input cannot wedge every later native activation. The deadline
  // begins only after the initial replica is ready: cold data transfer can take
  // longer than the eviction window without making a valid target look absent.
  useEffect(() => {
    if (!replicaReady) return
    const now = Date.now()
    for (const pending of pendingHrefs.current) {
      pending.expiresAt ??= now + PODIUM_LINK_RESOLUTION_TIMEOUT_MS
    }
    while (pendingHrefs.current.length > 0) {
      const pending = pendingHrefs.current[0]
      if (pending === undefined) break
      nativeResolution.current = true
      let activated: boolean
      try { activated = activatePodiumHref(pending.href) } finally { nativeResolution.current = false }
      if (
        activated ||
        (pending.expiresAt !== null && pending.expiresAt <= now)
      ) {
        pendingHrefs.current.shift()
        pending.acknowledge()
        continue
      }
      if (pending.expiresAt === null) return
      const retry = window.setTimeout(
        () => setPendingRevision((value) => value + 1),
        pending.expiresAt - now,
      )
      return () => window.clearTimeout(retry)
    }
  }, [issues, sessions, pendingRevision, replicaReady, demandedArtifacts])

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
})

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
