import type { IssueColorSlot } from '@podium/domain'
import type {
  IssueWire,
  MetadataChange,
  RepoOp,
  ServerMessage,
  SessionMeta,
} from '@podium/protocol'
import type { PodiumSettings } from '@podium/runtime'
import type { EntityChangeSpec } from '@podium/sync'
import type { LinearIssue } from '../../../linear'
import type { llmClient } from '../../../llm'
import type { IssueMessageRow, IssueRow, SessionStore } from '../../../store'
import type { PublishSpec } from '../publish'

/** The write-funnel face IssueService mutations run through (issue #190): the
 *  write-only sites (mail, subscriptions — no publishable change) enter `run`
 *  for its authorize → write ordering, and every issue fan-out enters
 *  `publishComputed` AFTER the ledger durably appended the changes at the write
 *  seam ([spec:SP-3fe2] #255). Structurally satisfied by
 *  {@link ../../funnel.WriteFunnel}; narrow so tests can fake it. Authorization
 *  happens UPSTREAM (router / issue-commands authz) — service-level ops pass no
 *  `authorize` stage of their own. */
export interface IssueFunnel {
  run<T>(op: { authorize?: () => void; write: () => T }): T
  /** Legacy-snapshot fan-out for a ledger-committed change. NO oplog append
   *  and NO metadataDelta — the append happened atomically with the write
   *  (Ledger.commit/reconcile) and delta clients receive it via the funnel's
   *  ordered onAppended pipe ([spec:SP-3fe2] #256). */
  publishComputed(snapshot: ServerMessage): void
}

/** The write-seam change log face ([spec:SP-3fe2] #255): `commit` binds an
 *  issue write and its declared change rows into one transaction; `reconcile`
 *  diffs the full wire truth (including removes) for the derived-ripple and
 *  boot paths. Structurally satisfied by {@link @podium/sync.Ledger}; narrow
 *  so tests can fake it. */
export interface IssueLedger {
  commit<T>(op: { write: () => T; changes: (result: T) => EntityChangeSpec[] }): {
    result: T
    changes: MetadataChange[]
  }
  reconcile(entity: 'issue', rows: { id: string; value: unknown }[]): MetadataChange[]
}

/** Publish-spec factory for the two issue wire shapes. The relay implements it
 *  with IssuePublisher, which unions hub-mirrored issues into the list snapshot
 *  (node-hub-issues §2.1) — the service never learns about the mirror. */
export interface IssuePublishSpecs {
  /** Single-issue delta (issue #22) — the issueUpdated legacy snapshot. */
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
  | {
      op: 'artifact-add'
      path: string
      title?: string
      /** Permanent-store snapshot fields ([spec:SP-0fc9]) — set by panelArtifactAdd
       *  after the pull succeeded; a bare artifact-add stays a legacy path entry. */
      artifactId?: string
      entry?: string
      files?: { path: string; size: number }[]
    }
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
   *  `spawnedBy` records provenance (issue #60): issue workflow calls preserve
   *  their exact initiating session/operator when known, with `issue:<id>` as the
   *  legacy direct-service fallback. [spec:SP-ccb2] */
  spawnSession(o: {
    cwd: string
    /** Explicit issue attachment (POD-529): the workflow knows the issue, so the
     *  session must not fall back to cwd-derived attachment (or a DRAFT birth ref). */
    issueId?: string
    agentKind?: string
    model?: string
    effort?: string
    /** Deliberately spawn with a model slug the live catalog doesn't list [spec:SP-cc60]. */
    forceUnknownModel?: boolean
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
  /** The write-seam change log ([spec:SP-3fe2] #255): issue writes commit their
   *  change rows atomically with the row write; derived ripples reconcile. */
  ledger: IssueLedger
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
  /** Permanent artifact snapshot store ([spec:SP-0fc9] #441) — the server-pull
   *  snapshotter panelArtifactAdd/Remove ride. Optional so existing test deps
   *  literals stay valid; absent ⇒ legacy path-only artifact entries. */
  artifacts?: {
    snapshot(o: {
      issueId: string
      root: string
      machineId?: string
      sourcePath: string
      extraPaths?: string[]
    }): Promise<{ artifactId: string; entry: string; files: { path: string; size: number }[] }>
    remove(issueId: string, artifactId: string): Promise<void>
    removeIssue(issueId: string): Promise<void>
  }
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
  /** Colour slot name [spec:SP-b4d1]; absent = no colour (neutral slate flow). */
  color?: IssueColorSlot
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
    | 'color'
    | 'estimateMin'
    | 'needsHuman'
    | 'humanQuestion'
    | 'humanQuestionOptions'
    | 'humanQuestionAskedBy'
    | 'humanQuestionAskedAt'
  >
>
