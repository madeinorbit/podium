import type { IssueWire, SessionMeta } from '@podium/protocol'
import type { FileTab } from './store'

/** The four right-dock tabs. Persisted under 'podium.dockTab'. */
export type DockTab = 'superagent' | 'files' | 'git' | 'issue'

export function readStoredDockTab(raw: string | null): DockTab {
  return raw === 'files' || raw === 'git' || raw === 'issue' ? raw : 'superagent'
}

export interface ActiveWorktree {
  cwd: string
  machineId?: string
}

/** True when `cwd` sits at or under `root` (path containment, POSIX). */
export function cwdInWorktree(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** Resolve the worktree the dock's Files/Issue tabs should target: paneA's
 *  session cwd, or a file tab's containment root, else the most recently
 *  active session. Null = nothing to show. */
export function resolveActiveWorktree(args: {
  paneA: string | null
  fileTabs: FileTab[]
  sessions: SessionMeta[]
}): ActiveWorktree | null {
  const { paneA, fileTabs, sessions } = args
  if (paneA != null) {
    const session = sessions.find((s) => s.sessionId === paneA)
    if (session) return { cwd: session.cwd, machineId: session.machineId }
    const tab = fileTabs.find((t) => t.id === paneA)
    if (tab && tab.worktreePath) {
      const machineId = tab.scope.kind === 'worktree' ? tab.scope.machineId : undefined
      return { cwd: tab.worktreePath, machineId }
    }
  }
  // Fall back to the most recently active non-archived session.
  let best: SessionMeta | null = null
  for (const s of sessions) {
    if (s.archived) continue
    if (!best || s.lastActiveAt > best.lastActiveAt) best = s
  }
  return best ? { cwd: best.cwd, machineId: best.machineId } : null
}

/** The issue whose worktree contains `cwd` (same containment rule the sidebar
 *  uses to group sessions under issues). */
export function issueForCwd(issues: IssueWire[], cwd: string): IssueWire | null {
  return (
    issues.find((i) => i.worktreePath != null && cwdInWorktree(cwd, i.worktreePath)) ?? null
  )
}

/** True when a panel has anything worth rendering. */
export function panelNonEmpty(issue: IssueWire): boolean {
  const p = issue.panel
  if (!p) return false
  return p.todos.length > 0 || p.artifacts.length > 0 || p.deferred.length > 0
}

/** Subissues of `parent` that have published a non-empty panel. */
export function subissuesWithPanels(issues: IssueWire[], parentId: string): IssueWire[] {
  return issues.filter((i) => i.parentId === parentId && panelNonEmpty(i))
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov'])

export type ArtifactKind = 'image' | 'video' | 'file'

export function artifactKind(path: string): ArtifactKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return 'file'
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** URL for serving an artifact's bytes out of a worktree checkout via the
 *  server's /files/asset route (root-scoped variant of asset-url.ts). */
export function worktreeAssetUrl(args: {
  httpOrigin: string
  root: string
  path: string
  machineId?: string
}): string {
  const qs = new URLSearchParams({ root: args.root, path: args.path })
  if (args.machineId) qs.set('machineId', args.machineId)
  return `${args.httpOrigin.replace(/\/+$/, '')}/files/asset?${qs.toString()}`
}
