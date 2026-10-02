import {
  type AgentKind,
  actorUser,
  DRAFT_ISSUE_TITLE,
  type IssueId,
  isSortKey,
  type MachineId,
  type RepoId,
  type SessionId,
  type SessionUserStateWire,
  sortKeyBetween,
  spawnedByTag,
  type UserId,
} from '@podium/model'
import type { IssueViewModel } from '../replica/issue-view-models'
import type { SessionValues, SessionView } from '../session-values'

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
  sessionId: SessionId
  issueId: IssueId
  agentKind: AgentKind
  cwd: string
  machineId?: MachineId
  /** ISO timestamp; injected so the builders stay pure/testable. */
  nowIso: string
}

/** The placeholder session's own facts. Its per-user cells are not among them:
 *  they are {@link optimisticSessionUserState}, joined in by the reader
 *  (POD-4974 S3c). */
export type StartingSessionRow = Omit<SessionView, keyof Pick<SessionValues, 'readAt' | 'unread'>>

/** A just-clicked, not-yet-booted session: `status: 'starting'`, no controller. */
export function optimisticStartingSession(args: OptimisticSpawnArgs): StartingSessionRow {
  return {
    sessionId: args.sessionId,
    agentKind: args.agentKind,
    title: basename(args.cwd) || args.cwd,
    cwd: args.cwd,
    ...(args.machineId !== undefined ? { machineId: args.machineId } : {}),
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
    spawnedBy: spawnedByTag({ kind: 'user' }),
  }
}

/** The spawning user's own row for the placeholder session: just spawned by
 *  them, so they are looking at it — read at its first activity, not unread. */
export function optimisticSessionUserState(args: {
  userId: UserId
  sessionId: SessionId
  nowIso: string
}): SessionUserStateWire {
  return { userId: args.userId, sessionId: args.sessionId, readAt: args.nowIso }
}

/** The draft-issue vessel the server auto-creates for a low-friction start —
 *  mirrors `issues.createDraftFor` → `issues.create` defaults. */
export function optimisticDraftSortKey(
  issues: readonly IssueViewModel[],
  repoPath: string,
  repoId?: RepoId,
): string {
  let min: string | null = null
  for (const issue of issues) {
    if (issue.deletedAt || issue.parentId || issue.pinned) continue
    const sameRepo = issue.repoId ? issue.repoId === repoId : issue.repoPath === repoPath
    if (!sameRepo || !isSortKey(issue.sortKey)) continue
    if (min === null || issue.sortKey < min) min = issue.sortKey
  }
  return sortKeyBetween(null, min)
}

export function optimisticDraftIssue(
  args: Pick<OptimisticSpawnArgs, 'issueId' | 'machineId' | 'agentKind' | 'nowIso'> & {
    userId: UserId
    repoPath: string
    repoId?: RepoId
    sortKey: string
  },
): IssueViewModel {
  return {
    id: args.issueId,
    owner: args.userId,
    visibility: 'personal',
    createdBy: { actor: actorUser(args.userId), onBehalfOf: args.userId },
    repoPath: args.repoPath,
    ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
    // Placeholders reconciled by the broadcast: the real row carries a server seq
    // (>= 1) and server-clock timestamps. Invisible today — the draft-agent row
    // labels from the session title and sorts to the top regardless — but a future
    // view that renders issue.seq for drafts would see a 0 -> N jump on reconcile.
    seq: 0,
    title: DRAFT_ISSUE_TITLE,
    description: '',
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: args.agentKind,
    defaultModel: 'auto',
    defaultEffort: 'auto',
    blockedByNotes: [],
    priority: 2,
    type: 'task',
    pinned: false,
    sortKey: args.sortKey,
    needsHuman: false,
    labels: [],
    deps: [],
    dependents: [],
    ready: false,
    blocked: false,
    deferred: false,
    childIds: [],
    memberSessionIds: [],
    tuckedAt: null,
    displayRef: args.issueId,
    childCount: 0,
    childDoneCount: 0,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
    archived: false,
    // Just created by this user → read. `unread` is NOT set: it left the wire
    // with the session embed (POD-797) and the reader derives it from `readAt`
    // against the sessions it holds.
    readAt: args.nowIso,
    intentOrigin: 'human',
    audience: 'human',
    isDraftVessel: true,
    // No `sessions` / `sessionSummary`: the embed left the wire (POD-797). The
    // sidebar already read membership from the global session list by issueId,
    // which is why nothing here needs a replacement.
  }
}

/** A named task whose first session is starting. The server will replace the
 * provisional sequence, sort key, worktree and timestamps with the same-id row;
 * everything the operator is reading is already final. */
export function optimisticStartedIssue(args: {
  userId: UserId
  issueId: IssueId
  repoPath: string
  repoId?: RepoId
  machineId?: MachineId
  sortKey: string
  title: string
  description: string
  brief?: string
  parentBranch?: string
  agentKind: AgentKind
  model?: string
  effort?: string
  nowIso: string
}): IssueViewModel {
  return {
    ...optimisticDraftIssue({
      userId: args.userId,
      issueId: args.issueId,
      repoPath: args.repoPath,
      repoId: args.repoId,
      sortKey: args.sortKey,
      agentKind: args.agentKind,
      nowIso: args.nowIso,
    }),
    ...(args.machineId !== undefined ? { machineId: args.machineId } : {}),
    title: args.title,
    description: args.description,
    ...(args.brief ? { brief: args.brief } : {}),
    parentBranch: args.parentBranch ?? 'main',
    defaultModel: args.model ?? 'auto',
    defaultEffort: args.effort ?? 'auto',
    stage: 'in_progress',
    isDraftVessel: false,
  }
}
