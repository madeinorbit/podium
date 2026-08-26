import { shallowEqual } from '@podium/client-core/store'
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
      if (!open) return
      switch (open.kind) {
        case 'issue':
          setOpenIssueId(open.issueId)
          setView('issues')
          return
        case 'session':
          navigateToSession(open.sessionIdOrRef)
          return
        case 'artifact':
          openArtifact({
            issueId: open.issueId,
            artifactId: open.artifactId as ArtifactId,
            path: open.path,
            ...(open.worktreePath ? { worktreePath: open.worktreePath } : {}),
          })
          return
        case 'file':
          openFileInWorktree({
            root: open.root,
            path: open.path,
            ...(open.machineId ? { machineId: open.machineId } : {}),
          })
          return
        default:
          // A plain page. Only the views this build routes are followed; an
          // address it does not know is left to the anchor, which is a real
          // navigation and therefore still correct.
          if (open.path === '/' || open.path === '/workspace') setView('workspace')
          else if (open.path.startsWith('/settings')) setView('settings')
          else if (open.path === '/usage') setView('usage')
          else if (open.path === '/issues') setView('issues')
          else if (open.path === '/automations') setView('automations')
          else if (open.path === '/specs') setView('specs')
          else if (open.path === '/workflows') setView('workflows')
      }
    })
    return () => setPodiumTargetActivator(null)
  })

  return null
}
