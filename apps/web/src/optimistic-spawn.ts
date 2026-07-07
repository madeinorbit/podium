import type { AgentKind, IssueWire, SessionMeta } from '@podium/protocol'

/**
 * Optimistic-UI builders for the "New <Agent> in <Repo>" spawn (issue #119).
 *
 * A create mints server-assigned ids, so — unlike the edit mutations already wired
 * into the optimistic path — the client can't pre-insert a row without an id. We
 * close that gap by generating the ids client-side and passing them to the server
 * verbatim; these builders produce the fully-valid rows the store's optimistic
 * overlay shows instantly, until the server's own broadcast (same ids) reconciles.
 *
 * They mirror the server's construction (`relay.spawn` / `issues.createDraftFor` →
 * `issues.create`) so the optimistic row and the eventual real row are the same
 * shape — no flicker on reconcile. The builders are unit-tested against the
 * protocol zod schemas so a new required field fails the test, not the UI.
 */

/**
 * Overlay merge for the optimistic path: `base` (server truth) plus any `overlay`
 * rows whose id isn't already in `base`. Base always wins — so when the real row
 * (same id) arrives it replaces the optimistic one with no duplicate. Returns the
 * SAME `base` reference when nothing is added, so an empty/reconciled overlay
 * doesn't churn the live-query consumers into a re-render.
 */
export function mergeOptimistic<T>(base: T[], overlay: T[], keyOf: (row: T) => string): T[] {
  if (overlay.length === 0) return base
  const baseKeys = new Set(base.map(keyOf))
  const extra = overlay.filter((row) => !baseKeys.has(keyOf(row)))
  return extra.length === 0 ? base : [...base, ...extra]
}

/** Browser-safe basename — the server titles a fresh session `basename(cwd)`. */
function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export interface OptimisticSpawnArgs {
  sessionId: string
  issueId: string
  agentKind: AgentKind
  cwd: string
  /** ISO timestamp; injected so the builders stay pure/testable. */
  nowIso: string
}

/** A just-clicked, not-yet-booted session: `status: 'starting'`, no controller. */
export function optimisticStartingSession(args: OptimisticSpawnArgs): SessionMeta {
  return {
    sessionId: args.sessionId,
    agentKind: args.agentKind,
    title: basename(args.cwd) || args.cwd,
    cwd: args.cwd,
    status: 'starting',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: args.nowIso,
    lastActiveAt: args.nowIso,
    origin: { kind: 'spawn' },
    archived: false,
    issueId: args.issueId,
    spawnedBy: 'user',
  }
}

/** The draft-issue vessel the server auto-creates for a low-friction start —
 *  mirrors `issues.createDraftFor` → `issues.create` defaults. */
export function optimisticDraftIssue(args: {
  issueId: string
  repoPath: string
  agentKind: AgentKind
  nowIso: string
}): IssueWire {
  return {
    id: args.issueId,
    repoPath: args.repoPath,
    seq: 0,
    title: 'Draft',
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: args.agentKind,
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedBy: [],
    priority: 2,
    type: 'task',
    pinned: false,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    comments: [],
    ready: false,
    blocked: false,
    deferred: false,
    childCount: 0,
    childDoneCount: 0,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
    archived: false,
    origin: 'human',
    draft: true,
    // Derived server-side; the sidebar reads membership from the global session
    // list (by issueId), not this embedded array, so empty is correct.
    sessions: [],
    sessionSummary: { total: 0, byPhase: {} },
  }
}
