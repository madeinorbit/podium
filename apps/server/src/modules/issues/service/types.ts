import type { IssueColorSlot, IssueTreeSession, IssueWire, SessionMeta } from '@podium/model'
import type { MetadataChange, RepoOp, ServerMessage } from '@podium/protocol'
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
  /** Partial-truth append for a single derived row (POD-210): dedups against
   *  the baseline, never diffs the list — see Ledger.capture. */
  capture(specs: EntityChangeSpec[]): MetadataChange[]
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
export const AUTO_ARCHIVE_READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

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

/**
 * Compact session row on an issue-tree node [spec:SP-99d3]. Enough for an agent
 * to see sibling sessions before spawn — not a full SessionMeta.
 */
/** Inventory §2.1 #19: the definition moved to `@podium/model`
 *  (`projections/session-read.ts`) so `@podium/issue-client` can import it
 *  instead of hand-copying it as `ShowSession` (#20). Re-exported here because
 *  `IssueTreeNode` and this module's consumers name it from here — the
 *  definition moved, the import surface did not (POD-366). */
export type { IssueTreeSession }

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
  /** Sessions currently on this issue (siblings), compact [spec:SP-99d3]. */
  sessions: IssueTreeSession[]
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
    accountId?: string
    /** Deliberately spawn with a model slug the live catalog doesn't list [spec:SP-cc60]. */
    forceUnknownModel?: boolean
    initialPrompt?: string
    spawnedBy?: string
    machineId?: string
  }): {
    sessionId: string
    agentId?: string
    harness?: string
    model?: string | null
    effort?: string | null
    machine?: string
  }
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
  /** Clear a session's agent action offer [spec:SP-c7f1]. Injected by the relay;
   *  optional so existing test deps literals stay valid. Used to retire pending
   *  decisions when an issue closes (POD-290) so a delegate offer cannot keep
   *  demanding attention after the work is finished elsewhere. */
  clearSessionOffer?(sessionId: string): void
  /** Fired after a worktree is successfully created (POD-665) so connected clients
   *  can re-fetch repos — otherwise a freshly-started issue's worktree is invisible
   *  in every menu until reload. [spec:SP-4ef9] worktree is a per-(branch,machine)
   *  materialization the client has no other way to learn about live. Injected by
   *  the relay; optional so existing test deps literals stay valid. */
  onWorktreesChanged?(repoPath: string, machineId?: string): void
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

/**
 * A row field as a CREATE input: optional, and never `null`. Absent means "use
 * the default", so admitting `null` as well would give one intent two spellings
 * — which is why this is not simply `Partial<Pick<IssueRow, K>>`. {@link IssuePatch}
 * keeps the `null`s, because clearing a field IS a patch.
 */
type CreatableRowFields<K extends keyof IssueRow> = {
  [P in K]?: NonNullable<IssueRow[P]>
}

/**
 * The create-command input, composed from {@link IssueRow} rather than restated
 * (POD-367; POD-364's inventory #5 — the drifted duplicate of the create field
 * set). {@link IssuePatch} was already the compliant reference pattern; this is
 * the same pattern for create.
 *
 * Only three groups are declared by hand, each because it is genuinely NOT the
 * row's field:
 *  - `stage` is deliberately NARROWER than `IssueRow['stage']` (a bare string):
 *    a caller may not forge proposal acceptance.
 *  - `origin` / `audience` are narrower for the same reason the row is wider —
 *    the row stores what was written, the input constrains what may be. The row's
 *    `string` typing is the drift; correcting it belongs to the aggregate work.
 *  - `startNow`, `linear` and `labels` are not row fields at all: the first is a
 *    create-time action, the second is folded into three `linear*` columns, and
 *    labels live in their own table.
 *
 * Two composed members carry create-time meaning the row's own docs do not, kept
 * here because it is about the INPUT, not the column:
 *  - `id` is the client-supplied id (optimistic UI): used verbatim instead of
 *    minting a fresh `iss_${uuid}`, so an optimistic client row reconciles onto
 *    the real issue without a swap. Absent = mint one.
 *  - `startedBySession` is stamped by the registry from the AUTHENTICATED actor
 *    and is not client-forgeable via tRPC input (ADR 3 D7 — identity comes from
 *    the transport, never the payload). Null/absent for operator creates.
 */
export interface CreateIssueInput
  extends Pick<IssueRow, 'repoPath' | 'title' | 'startedBySession'>,
    CreatableRowFields<
      | 'id'
      | 'description'
      | 'brief'
      | 'parentBranch'
      | 'defaultAgent'
      | 'defaultModel'
      | 'defaultEffort'
      | 'machineId'
      | 'priority'
      | 'type'
      | 'assignee'
      | 'parentId'
      | 'color'
      | 'draft'
    > {
  /** Internal/server-selected initial stage; callers cannot forge proposal acceptance. */
  stage?: 'proposed' | 'backlog'
  startNow: boolean
  linear?: { id?: string; identifier: string; url: string }
  labels?: string[]
  /** Who CREATED this issue; caller-derived, default 'human' (#198). */
  origin?: 'human' | 'agent'
  /** Who this issue is FOR; agent-declared, default 'human' (#198). */
  audience?: 'human' | 'agent'
}

/** The row fields update() accepts — every mutation entry point (router, CLI/MCP
 *  registry, board drag) converges on update() with one of these. */
export type IssuePatch = Partial<
  Pick<
    IssueRow,
    | 'title'
    | 'description'
    | 'brief'
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
    | 'sortKey'
    | 'color'
    | 'estimateMin'
    | 'needsHuman'
    | 'humanQuestion'
    | 'humanQuestionOptions'
    | 'humanQuestionAskedBy'
    | 'humanQuestionAskedAt'
    | 'coordinatorSessionId'
  >
>
