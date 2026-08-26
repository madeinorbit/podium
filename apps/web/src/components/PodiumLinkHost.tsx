import { shallowEqual } from '@podium/client-core/store'
import type { MainView } from '@podium/client-core/ui-state'
import type { ArtifactId } from '@podium/model/browser'
import { useEffect } from 'react'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { setKnownPodiumOrigins, setPodiumTargetActivator } from '@/lib/podium-link'
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
export function PodiumLinkHost(): null {
  const {
    httpOrigin,
    setOpenIssueId,
    setView,
    navigateToSession,
    openArtifact,
    openFileInWorktree,
  } = useStoreSelector(
    (s) => ({
      httpOrigin: s.httpOrigin,
      setOpenIssueId: s.setOpenIssueId,
      setView: s.setView,
      navigateToSession: s.navigateToSession,
      openArtifact: s.openArtifact,
      openFileInWorktree: s.openFileInWorktree,
    }),
    shallowEqual,
  )
  const issues = useReplicaIssues()

  useEffect(() => {
    setKnownPodiumOrigins(httpOrigin ? [httpOrigin] : [])
  }, [httpOrigin])

  useEffect(() => {
    setPodiumTargetActivator((target) => {
      const open = resolvePodiumTarget(target, { issues })
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
          // A FRAGMENT ALSO NEEDS THE ANCHOR. `#advanced` names a part of the
          // page, and `routePath` has nowhere to put it — setView would land the
          // reader at the top of the right page and quietly lose what they
          // clicked. The browser honours it, so let the browser have it.
          if (open.hash) return false
          const view = mainViewForPath(open.path)
          if (!view) return false
          setView(view)
          return true
        }
      }
    })
    return () => setPodiumTargetActivator(null)
  })

  return null
}

/** The one view this build would show for a plain in-app path, or null when it
 *  has none — which is the answer for every backend route and every file the
 *  server serves outside the SPA. */
function mainViewForPath(path: string): MainView | null {
  const head = path.split('/').filter(Boolean)[0]
  if (head === undefined) return 'workspace'
  if (head === 'workspace') return 'workspace'
  if (head === 'settings') return 'settings'
  if (head === 'issues') return 'issues'
  if (head === 'usage' || head === 'automations' || head === 'specs' || head === 'workflows') {
    return head
  }
  return null
}
