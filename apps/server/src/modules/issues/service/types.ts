import type { PodiumSettings } from '@podium/runtime'
import type { IssueWire, RepoOp, SessionMeta } from '@podium/protocol'
import type { LinearIssue } from '../../../linear'
import type { llmClient } from '../../../llm'
import type { IssueMessageRow, IssueRow, SessionStore } from '../../../store'
import type { PublishSpec } from '../../funnel'

/** The write-funnel face IssueService mutations run through (issue #190): every
 *  store write enters `run` (authorize → repository write → oplog append →
 *  broadcast) and every fan-out without its own write (cross-issue derived
 *  effects) enters the shared `publishSpec` tail. Structurally satisfied by
 *  {@link ../../funnel.WriteFunnel}; narrow so tests can fake it. Authorization
 *  happens UPSTREAM (router / issue-commands authz) — service-level ops pass no
 *  `authorize` stage of their own. */
export interface IssueFunnel {
  run<T>(op: {
    authorize?: () => void
    write: () => T
    publish?: (result: T) => PublishSpec | null
  }): T
  publishSpec(spec: PublishSpec): void
  /** Durable oplog append with no fan-out — boot reconciliation. Optional so
   *  narrow test fakes stay valid. */
  record?(entity: 'issue', rows: { id: string; value: unknown }[]): unknown
}

/** Publish-spec factory for the two issue wire shapes. The relay implements it
 *  with IssuePublisher, which unions hub-mirrored issues into the list snapshot
 *  (node-hub-issues §2.1) — the service never learns about the mirror. */
export interface IssuePublishSpecs {
  /** Single-issue delta (issue #22) — a PARTIAL oplog record + issueUpdated. */
  issueUpdated(issue: IssueWire): PublishSpec
  /** Full-list snapshot (membership / cross-issue derived changes). */
  issuesChanged(localIssues: IssueWire[]): PublishSpec
}

/** Read-gated auto-archive window (issue #127): a done+read issue auto-archives
 *  this long after it was read. Reading starts the clock; unread issues wait. */
export const AUTO_ARCHIVE_READ_WINDOW_MS = 24 * 60 * 60 * 1000

/** Manual unsnooze backdate (issue #133): `undefer` sets deferUntil this far in the
 *  past rather than to exactly "now". The sidebar reads snooze state off a coarse
 *  on-screen clock (useNow, minute granularity) that can lag real time by up to a
 *  minute, so a deferUntil of exactly-now would read as still-snoozed for up to that
 *  long. Backdating well past that window flips the issue to returned-from-defer
 *  (top-of-WORK + "Unsnoozed" tag) immediately. deferUntil is only compared, never
 *  displayed, so the backdate is invisible. */
export const UNSNOOZE_BACKDATE_MS = 5 * 60 * 1000

/** One mutation on the agent-published human panel — see IssueService.panelApply. */
export type IssuePanelOp =
  | { op: 'todo-add'; text: string }
  | { op: 'todo-done' | 'todo-undone' | 'todo-remove'; index: number }
  | { op: 'todo-clear' }
  | { op: 'artifact-add'; path: string; title?: string }
  | { op: 'artifact-remove'; index: number }
  | { op: 'deferred-add'; text: string }
  | { op: 'deferred-remove'; index: number }

/** One edge endpoint in a dep report: enough to render "#12 title (open, blocks)". */
export interface DepReportRef {
  seq: number
  title: string
  type: string
  closed: boolean
}

/** Per-issue dependency status inside a set (epic subtree or repo) — see depReport(). */
export interface DepReportEntry {
  id: string
  seq: number
  title: string
  stage: string
  priority: number
  closed: boolean
  blocked: boolean
  ready: boolean
  /** Outgoing deps: issues this one waits on. */
  deps: DepReportRef[]
  /** Incoming deps: issues waiting on this one. */
  dependents: DepReportRef[]
}

/** One node of an epic subtree payload — see tree() (issue #82). */
export interface IssueTreeNode {
  id: string
  seq: number
  title: string
  stage: string
  priority: number
  type: string
  assignee?: string
  branch?: string
  needsHuman: boolean
  humanQuestion?: string
  /** Seqs of `blocks` targets this issue waits on (open or closed). */
  blocksDeps: number[]
  /** First 300 chars of the description, whitespace collapsed to one line. */
  description: string
  closed: boolean
  blocked: boolean
  ready: boolean
  children: IssueTreeNode[]
  /** Direct children omitted here by the depth/node cap ('(+N more)' in the CLI). */
  omittedChildren: number
}

export interface IssueTree {
  root: IssueTreeNode
  totalNodes: number
  /** Total children omitted across the tree by the depth/node cap. */
  omitted: number
}

export interface IssueDeps {
  store: SessionStore
  listSessions(): SessionMeta[]
  getSettings(): PodiumSettings
  /** Spawn a session in the issue's worktree. `initialPrompt` hands the agent its
   *  first prompt at spawn (argv for capable agents, draft-seed fallback otherwise —
   *  resolved inside createSession), which is the race-free way to start the work.
   *  `spawnedBy` records provenance (issue #60) — always `issue:<id>` from here. */
  spawnSession(o: {
    cwd: string
    agentKind?: string
    model?: string
    effort?: string
    initialPrompt?: string
    spawnedBy?: string
    machineId?: string
  }): { sessionId: string }
  repoOp(
    op: RepoOp,
    cwd: string,
    args?: Record<string, string>,
    machineId?: string,
  ): Promise<{ ok: boolean; output: string }>
  /** Pre-flight for an explicit machine pin: throws (actionable message) when the
   *  machine is offline or lacks the repo. Injected by the relay; optional so
   *  existing test deps literals stay valid. */
  requireMachineForRepo?(machineId: string, repoPath: string): void
  /** THE write funnel (modules/funnel): every mutation's store write + fan-out
   *  runs through it, so "durable before fan-out" holds by construction. */
  funnel: IssueFunnel
  /** Publish-spec factory (modules/issues/publish) for the funnel's tail. */
  publishSpecs: IssuePublishSpecs
  now?(): string
  /** The session's explicit issue attachment (issue-as-workspace). Injected by
   *  the relay; optional so existing test deps literals stay valid. */
  getSessionIssueId?(sessionId: string): string | null
  /** Move a session's explicit issue attachment (persist + sessions broadcast). */
  setSessionIssueId?(sessionId: string, issueId: string | null): void
  /** Archive/unarchive a session (persist + sessions broadcast). Injected by the
   *  relay; optional so existing test deps literals stay valid. Used to cascade an
   *  issue archive onto its member sessions (issue #133) so archiving an issue never
   *  leaves a bare, session-less worktree row in the sidebar. */
  setSessionArchived?(sessionId: string, archived: boolean): void
  defaultRepoBranch?(repoPath: string): Promise<string>
  llm?: typeof llmClient
  linearSearch?(key: string, q: string): Promise<LinearIssue[]>
  /** Send-time mail delivery hook (issue #103): the registry nudges the target
   *  issue's live agent session. Best-effort — sendMail swallows its failures. */
  onMailSent?(row: IssueRow, message: IssueMessageRow): void
}

export interface CreateIssueInput {
  repoPath: string
  title: string
  description?: string
  parentBranch?: string
  defaultAgent?: string
  defaultModel?: string
  defaultEffort?: string
  /** Machine (daemon) the issue's agents run on; absent = repo affinity. */
  machineId?: string
  startNow: boolean
  linear?: { id?: string; identifier: string; url: string }
  priority?: number
  type?: string
  assignee?: string
  labels?: string[]
  parentId?: string
  /** Who CREATED this issue; caller-derived, default 'human' (#198). */
  origin?: 'human' | 'agent'
  /** Who this issue is FOR; agent-declared, default 'human' (#198). */
  audience?: 'human' | 'agent'
  /** Draft vessel with a placeholder title (issue-as-workspace); default false. */
  draft?: boolean
  /** Client-supplied id (optimistic UI): used verbatim instead of minting a fresh
   *  `iss_${uuid}`, so an optimistic client row reconciles onto the real issue
   *  without a swap. Absent = mint one (unchanged default behavior). */
  id?: string
}

/** The row fields update() accepts — every mutation entry point (router, CLI/MCP
 *  registry, board drag) converges on update() with one of these. */
export type IssuePatch = Partial<
  Pick<
    IssueRow,
    | 'title'
    | 'description'
    | 'stage'
    | 'worktreePath'
    | 'branch'
    | 'parentBranch'
    | 'defaultAgent'
    | 'defaultModel'
    | 'defaultEffort'
    | 'machineId'
    | 'archived'
    | 'priority'
    | 'type'
    | 'assignee'
    | 'parentId'
    | 'design'
    | 'acceptance'
    | 'notes'
    | 'dueAt'
    | 'deferUntil'
    | 'closedReason'
    | 'supersededBy'
    | 'duplicateOf'
    | 'pinned'
    | 'estimateMin'
    | 'needsHuman'
    | 'humanQuestion'
  >
>
