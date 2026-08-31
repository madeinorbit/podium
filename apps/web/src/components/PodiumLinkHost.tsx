import { shallowEqual } from '@podium/client-core/store'
import type { MainView } from '@podium/client-core/ui-state'
import type { ArtifactId } from '@podium/model/browser'
import { useEffect, useRef, useState } from 'react'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import {
  PODIUM_NATIVE_OPEN_EVENT,
  activatePodiumHref,
  canonicalizePodiumAnchor,
  canonicalizePodiumAnchors,
  classifyPodiumLink,
  hasServerSelector,
  hasUnsupportedTypedDetail,
  setKnownPodiumOrigins,
  setPodiumTargetActivator,
} from '@/lib/podium-link'
import { resolvePodiumTarget } from '@/lib/podium-link-open'

/**
 * Makes Podium addresses live in this tab (POD-1606). Mounted once at app root
 * beside <RefMiniviewHost>, whose shape it copies; renders nothing.
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
export function PodiumLinkHost({ initialHref = null }: { initialHref?: string | null }): null {
  const {
    httpOrigin,
    sessions,
    setOpenIssueId,
    setView,
    navigateToSession,
    openArtifact,
    openFileInWorktree,
  } = useStoreSelector(
    (s) => ({
      httpOrigin: s.httpOrigin,
      sessions: s.sessions,
      setOpenIssueId: s.setOpenIssueId,
      setView: s.setView,
      navigateToSession: s.navigateToSession,
      openArtifact: s.openArtifact,
      openFileInWorktree: s.openFileInWorktree,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()
  const pendingHref = useRef<string | null>(initialHref)
  const [pendingRevision, setPendingRevision] = useState(0)

  useEffect(() => {
    setKnownPodiumOrigins(httpOrigin ? [httpOrigin] : [])
    if (httpOrigin) canonicalizePodiumAnchors(document)
  }, [httpOrigin])

  // Middle-click and context-menu Open/Copy do not dispatch an ordinary click.
  // Prepare any boot-rendered relative anchor during their capture phase so
  // the browser sees the active server before it performs its default action.
  useEffect(() => {
    const prepareAnchor = (event: Event): void => canonicalizePodiumAnchor(event.target)
    document.addEventListener('auxclick', prepareAnchor, true)
    document.addEventListener('contextmenu', prepareAnchor, true)
    return () => {
      document.removeEventListener('auxclick', prepareAnchor, true)
      document.removeEventListener('contextmenu', prepareAnchor, true)
    }
  }, [])

  useEffect(() => {
    setPodiumTargetActivator((target) => {
      const open = resolvePodiumTarget(target, { issues, sessions })
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

  // Startup addresses are captured before createRouter can normalize its
  // unknown path to /workspace. Keep retrying while replica rows arrive: refs,
  // sessions and artifact panel entries all need live data to resolve.
  useEffect(() => {
    const href = pendingHref.current
    if (href && activatePodiumHref(href)) pendingHref.current = null
  }, [issues, sessions, pendingRevision])

  // Native capture and window focus belong to POD-1710. This is the narrow web
  // half of that contract: one raw URL event, validated and routed through the
  // same resolver as every rendered link. No native-specific parser lives here.
  useEffect(() => {
    const onNativeOpen = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      if (typeof detail !== 'string') return
      const link = classifyPodiumLink(detail)
      if (
        link?.kind !== 'internal' ||
        hasServerSelector(detail) ||
        hasUnsupportedTypedDetail(link.target)
      ) {
        return
      }
      pendingHref.current = detail
      setPendingRevision((value) => value + 1)
    }
    window.addEventListener(PODIUM_NATIVE_OPEN_EVENT, onNativeOpen)
    return () => window.removeEventListener(PODIUM_NATIVE_OPEN_EVENT, onNativeOpen)
  }, [])

  return null
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
