import { randomUUID } from 'node:crypto'
import {
  asIssueId,
  asRepoId,
  asSessionId,
  asUserId,
  type GrantVerb,
  type IssueWire,
  isSortKey,
  normalizeClosedPatch,
  type SessionId,
  type SessionMeta,
  sortKeyBetween,
  type UserId,
} from '@podium/model'
import { resolveRole } from '@podium/runtime'
import type { EntityChangeSpec } from '@podium/sync'
import type { IssueRow } from '../../../store'
import { type StoredIssue, toStorage } from '../../../store/issue-storage'
import { findSessionById } from '../../sessions/session-by-id'
import type { IssueStore } from './core'
import type { CreateIssueInput, IssuePanelOp, IssuePatch } from './types'
import { UNSNOOZE_BACKDATE_MS } from './types'

/**
 * Board-organization fields only — pin / drag-reorder. These must not bump
 * `updatedAt` (and therefore must not re-flip derived `unread` via
 * `computeUnread`: lastActivity > readAt). Whitelist: any new IssuePatch field
 * defaults to content/activity behavior so accidental omission stays safe.
 */
const ORGANIZATIONAL_PATCH_KEYS = new Set<keyof IssuePatch>(['pinned', 'sortKey'])

function isOrganizationalOnlyPatch(patch: IssuePatch): boolean {
  const keys = Object.keys(patch) as (keyof IssuePatch)[]
  return keys.length > 0 && keys.every((k) => ORGANIZATIONAL_PATCH_KEYS.has(k))
}

/** Prepared half of the atomic issue/session lifecycle transaction. */
export interface IssueLifecyclePlan {
  issueId: string
  worktreePath: string | null
  /** The committed wire projection. Valid ONLY after {@link write} — throws
   *  before it, deliberately loudly.
   *
   *  A function rather than a field because the authority assigns `revision` at
   *  the SQL write (ADR 2 D3, IssuesRepository.upsertIssue), so a projection
   *  taken while building the plan would carry a stale token: it would ship a
   *  revision the client then echoes in `expectedRevision`, and the authority
   *  would reject the client's next write against state the client had been
   *  handed. A field could hold that stale value silently; a call that throws
   *  cannot. The ordering rule generalizes past revision — any
   *  authority-assigned field has it. */
  wire(): IssueWire
  write(): void
  changes(): EntityChangeSpec[]
  apply(): void
  publish(): void
}

/**
 * CRUD and stage-machine capability:
 * create/update and every close/reopen path, dependency + hierarchy edits,
 * labels/comments/panel/state, and the attention-state event emissions that
 * update() detects. Every mutation ends in persist()/broadcastList() (core).
 */
interface IssueCrudHierarchyPort {
  reparent(id: string, parentId: string | null): IssueWire
  setParentForUpdate(row: IssueRow, parentId: import('@podium/model').IssueId | null): void
}

interface IssueCrudAttentionPort {
  onIssueArchived(row: IssueRow): void
  retireIssueOffers(row: IssueRow): void
}

/** Narrow git-workflow face for inputs that invalidate derived gitState [POD-576]. */
interface IssueCrudGitWorkflowPort {
  refreshGitState(id: string, fallbackCwd?: string): Promise<void>
}

export class IssueCrudModule {
  constructor(
    readonly store: IssueStore,
    private readonly hierarchy: () => IssueCrudHierarchyPort,
    private readonly attention: () => IssueCrudAttentionPort,
    private readonly gitWorkflow: () => IssueCrudGitWorkflowPort,
  ) {}

  /** Agent-posted "where things stand" — writes activityNotes directly (the same
   *  field the assistant digest maintains; an explicit agent post is fresher truth
   *  and simply overwrites, and vice versa). Shown in the issue sidebar header. */
  setState(id: string, text: string): IssueWire {
    const row = this.store.rowOrThrow(id)
    row.activityNotes = text
    row.notesUpdatedAt = this.store.now()
    const wire = this.store.persist(row)
    this.store.emitEvent('issue.state', row.id, { seq: row.seq })
    return wire
  }

  /** Apply one mutation to an issue's agent-published human panel (right-sidebar
   *  "Issue" tab): human-facing todos, artifacts (files the user should look at),
   *  and deferred-work items awaiting a user decision. Indexes are 1-based (what
   *  the CLI prints). Persists + broadcasts like any other issue update. */
  panelApply(id: string, op: IssuePanelOp): IssueWire {
    const row = this.store.rowOrThrow(id)
    const panel = this.store.parsePanel(row)
    const at = <T>(list: T[], index: number): T => {
      const item = list[index - 1]
      if (!item) throw new Error(`no item ${index} (list has ${list.length})`)
      return item
    }
    switch (op.op) {
      case 'todo-add':
        panel.todos.push({ text: op.text, done: false })
        break
      case 'todo-done':
        at(panel.todos, op.index).done = true
        break
      case 'todo-undone':
        at(panel.todos, op.index).done = false
        break
      case 'todo-remove':
        at(panel.todos, op.index)
        panel.todos.splice(op.index - 1, 1)
        break
      case 'todo-clear':
        panel.todos = []
        break
      case 'artifact-add': {
        // Re-adding the same path replaces its entry IN PLACE (agents iterate on
        // artifacts; the list position is stable — [spec:SP-0fc9]).
        const next = {
          path: op.path,
          ...(op.title ? { title: op.title } : {}),
          addedAt: this.store.now(),
          ...(op.artifactId ? { artifactId: op.artifactId } : {}),
          ...(op.entry ? { entry: op.entry } : {}),
          ...(op.files ? { files: op.files } : {}),
        }
        const existing = panel.artifacts.findIndex((a) => a.path === op.path)
        if (existing >= 0) panel.artifacts[existing] = next
        else panel.artifacts.push(next)
        break
      }
      case 'artifact-remove':
        at(panel.artifacts, op.index)
        panel.artifacts.splice(op.index - 1, 1)
        break
      case 'deferred-add':
        panel.deferred.push({ text: op.text, addedAt: this.store.now() })
        break
      case 'deferred-remove':
        at(panel.deferred, op.index)
        panel.deferred.splice(op.index - 1, 1)
        break
    }
    row.panel = JSON.stringify(panel)
    const wire = this.store.persist(row)
    this.store.emitEvent('issue.panel', row.id, { seq: row.seq, op: op.op })
    return wire
  }

  /**
   * artifact-add with permanent-store snapshotting ([spec:SP-0fc9] #441): pull
   * the bytes from the owning daemon into `<state-dir>/artifacts/<issueId>/`
   * BEFORE committing the panel entry — a pull/write failure errors the op with
   * nothing half-registered. Re-add of the same source path snapshots under a
   * NEW artifactId, swaps the entry in place, then deletes the old dir
   * (best-effort) AFTER the commit. Falls back to a legacy path-only entry when
   * no artifact store is wired (tests / minimal deployments).
   */
  async panelArtifactAdd(
    id: string,
    input: { path: string; title?: string; extraPaths?: string[] },
    opts?: { actorSessionId?: string },
  ): Promise<IssueWire> {
    const row = this.store.rowOrThrow(this.store.resolveRef(id))
    const store = this.store.deps.artifacts
    // Re-add keeps the existing title unless a new one is given.
    const existing = this.store.parsePanel(row).artifacts.find((a) => a.path === input.path)
    const effectiveTitle = input.title ?? existing?.title
    const title = effectiveTitle ? { title: effectiveTitle } : {}
    if (!store) return this.panelApply(row.id, { op: 'artifact-add', path: input.path, ...title })
    // Owning machine + root: the issue worktree, falling back to the invoking
    // session's machine/cwd — the same resolution the live render route uses.
    const session = opts?.actorSessionId
      ? findSessionById(this.store.deps, opts.actorSessionId)
      : undefined
    const root = row.worktreePath ?? session?.cwd
    if (!root) throw new Error('no worktree or session to read the artifact from')
    const machineId = row.machineId ?? session?.machineId ?? undefined
    const snap = await store.snapshot({
      issueId: row.id,
      root,
      ...(machineId ? { machineId } : {}),
      sourcePath: input.path,
      ...(input.extraPaths?.length ? { extraPaths: input.extraPaths } : {}),
    })
    const oldId = existing?.artifactId
    const wire = this.panelApply(row.id, {
      op: 'artifact-add',
      path: input.path,
      ...title,
      artifactId: snap.artifactId,
      entry: snap.entry,
      files: snap.files,
    })
    if (oldId) void store.remove(row.id, oldId).catch(() => {})
    return wire
  }

  /** artifact-remove that also deletes the snapshot's store dir ([spec:SP-0fc9]).
   *  The dir delete is best-effort AFTER the committed panel update. */
  panelArtifactRemove(id: string, index: number): IssueWire {
    const row = this.store.rowOrThrow(this.store.resolveRef(id))
    const removed = this.store.parsePanel(row).artifacts[index - 1]
    const wire = this.panelApply(row.id, { op: 'artifact-remove', index })
    if (removed?.artifactId && this.store.deps.artifacts) {
      void this.store.deps.artifacts.remove(row.id, removed.artifactId).catch(() => {})
    }
    return wire
  }

  /** Dependents of `closed` that its close just unblocked (their ONLY open blocker
   *  was `closed`): open rows in the same repo with a `blocks` dep on it whose wire
   *  `ready` is now true. Never throws — the close already persisted, and a sqlite
   *  read error in this fanout must not make the succeeded mutation look failed. */
  private emitReadyAfterClose(closed: IssueRow, actorSessionId?: string): void {
    try {
      const commentCounts = this.store.deps.store.issues.countIssueCommentsByIssue()
      for (const r of this.store.rows.values()) {
        if (
          r.id === closed.id ||
          !this.store.inRepoScope(r, closed.repoPath) ||
          this.store.isClosed(r)
        )
          continue
        const blocksClosed = this.store.deps.store.issues
          .listIssueDeps(r.id)
          .some((d) => d.type === 'blocks' && d.toId === closed.id)
        if (blocksClosed && this.store.toWire(r, commentCounts).ready) {
          this.store.emitEvent('issue.ready', r.id, {
            seq: r.seq,
            unblockedBy: closed.seq,
            ...(actorSessionId ? { causedBySessionId: actorSessionId } : {}),
          })
        }
      }
    } catch {}
  }

  /** Closing a parent retires its descendant progress record and stopped
   *  sessions [spec:SP-6144]. The cascade archives ONLY children that are
   *  themselves closed, already read, and have no live member session — open
   *  work, unread results, and running agents are skipped (and surfaced via a
   *  single issue.cascade_skipped event on the parent) instead of vanishing
   *  from the live views out from under the operator. */
  private archiveClosedSubtree(parentId: string, sessionList?: SessionMeta[]): void {
    sessionList ??= this.store.deps.listSessions()
    const skipped: Array<{ seq: number; why: string }> = []
    for (const child of this.store.rows.values()) {
      if (child.parentId !== parentId || child.archived || child.deletedAt) continue
      if (!this.store.isClosed(child)) continue // open work is never swept by a parent close
      // Per-user read state (POD-1076): the sweep asks the broadcast viewer,
      // which is what "the operator has seen it" meant when this was a column.
      if (this.store.issueOverlay(child.id).readAt == null) {
        skipped.push({ seq: child.seq, why: 'unread' })
        continue
      }
      const live = sessionList.some(
        (s) => s.issueId === child.id && !s.archived && s.status !== 'exited',
      )
      if (live) {
        skipped.push({ seq: child.seq, why: 'live session' })
        continue
      }
      this.archiveClosedSubtree(child.id, sessionList)
      this.update(child.id, { archived: true })
    }
    if (skipped.length) {
      const parent = this.store.rows.get(parentId)
      if (parent) {
        this.store.emitEvent('issue.cascade_skipped', parentId, { seq: parent.seq, skipped })
      }
    }
  }

  /** Mint a manual-order key ABOVE the sibling scope's current top (POD-168):
   *  "new appears at top" (R2) is the sort's natural behavior, no special case.
   *  Scope = a parent's children when parentId is set, else the repo's
   *  top-level non-pinned rows. Corrupt/legacy keys are ignored for the min. */
  private mintSortKey(repoId: string, repoPath: string, parentId: string | null): string {
    let min: string | null = null
    for (const r of this.store.rows.values()) {
      if (r.deletedAt) continue
      const sameScope = parentId
        ? r.parentId === parentId
        : r.parentId == null &&
          !this.store.issueOverlay(r.id).pinned &&
          (r.repoId ? r.repoId === repoId : r.repoPath === repoPath)
      if (!sameScope) continue
      const k = r.sortKey
      if (isSortKey(k) && (min === null || k < min)) min = k
    }
    return sortKeyBetween(null, min)
  }

  create(input: CreateIssueInput): IssueWire {
    // Allocate the #N off the stable repo_id so all checkouts of one origin share a
    // single sequence (#140) — resolve the path to its repo_id first, then allocate.
    const repoId = this.store.deps.store.repos.resolveRepoIdForPath(input.repoPath)
    const seq = this.store.deps.store.issues.nextIssueSeq(repoId)
    const ts = this.store.now()
    const settings = this.store.deps.getSettings()
    const coding = resolveRole(settings, 'coding')
    const defaultAgent = input.defaultAgent || coding.harness
    const useCodingDefaults = defaultAgent === coding.harness // [spec:SP-7ff1]
    // Built as the IN-MEMORY issue (R1) and encoded ONCE, through the pair that
    // owns the R1 <-> R3 splits (ADR 4 §4.1). Everything absent here is absent by
    // R1's own optionality — the storage nulls are `toStorage`'s to write, and
    // spelling them out again is the restatement this issue deletes.
    const issue: StoredIssue = {
      id: asIssueId(input.id ?? `iss_${randomUUID()}`),
      repoId: asRepoId(repoId),
      seq,
      title: input.title,
      description: { value: input.description ?? '' },
      ...(input.brief != null ? { brief: input.brief } : {}),
      stage: (input.stage ?? 'backlog') as StoredIssue['stage'],
      worktreePath: null,
      branch: null,
      parentBranch: input.parentBranch || settings.gitWorkflow.defaultParentBranch || 'main',
      defaultAgent,
      defaultModel:
        input.defaultModel || (useCodingDefaults ? settings.roles.coding.model : 'auto'),
      defaultEffort:
        input.defaultEffort || (useCodingDefaults ? settings.roles.coding.effort : 'auto'),
      ...(input.machineId != null ? { machineId: input.machineId } : {}),
      ...(input.linear?.id != null ? { linearId: input.linear.id } : {}),
      ...(input.linear?.identifier != null ? { linearIdentifier: input.linear.identifier } : {}),
      ...(input.linear?.url != null ? { linearUrl: input.linear.url } : {}),
      blockedByNotes: [],
      priority: input.priority ?? 2,
      // NOT AN ID CAST — this site carried an edge-cast marker that POD-362 read and
      // removed: `type`/`stage` are ENUM-ish text, not entity ids, so no brand applies.
      // They stay unvalidated here because the DDL CHECK is the constraint and
      // validating at this seam would turn a create the tracker accepts today into
      // a throw — a decoder/encoder change, and not this issue's.
      type: (input.type || 'task') as StoredIssue['type'],
      ...(input.assignee ? { assignee: asUserId(input.assignee) } : {}),
      // Keyed into the scope it will LAND in: the parent's children when this
      // is a subtask create (parentId is applied after persist via reparent,
      // so the scope is resolved from the input here).
      sortKey: this.mintSortKey(
        repoId,
        input.repoPath,
        input.parentId ? this.store.resolveRef(input.parentId, input.repoPath) : null,
      ),
      ...(input.color != null ? { color: input.color } : {}),
      needsHuman: false,
      createdAt: ts,
      updatedAt: ts,
      archived: false,
      // D-2's renames: the input keeps the wire's names, R1 uses the qualified
      // ones, and the pair maps them back onto the columns.
      intentOrigin: input.origin ?? 'human',
      audience: input.audience ?? 'human',
      isDraftVessel: input.draft ?? false,
      // Bare session id (same format as humanQuestionAskedBy / coordinatorSessionId).
      // Absent for operator creates; registry stamps agent creates from actorSessionId.
      ...(input.startedBySession != null
        ? { startedBySession: asSessionId(input.startedBySession) }
        : {}),
    }
    // The one R3-only column is not R1's to hold (see IssueStorageOnly): the repo
    // spelling is the registry's. A fresh issue is unread, untucked and unpinned
    // FOR EVERY USER, which after POD-1076 is expressed by writing no per-user row
    // rather than by three nulls on the shared row.
    const row: IssueRow = toStorage(issue, { repoPath: input.repoPath })
    row.ownerUserId = input.ownerUserId ?? asUserId('user:sole')
    row.visibility = input.visibility ?? 'personal'
    row.createdByActor = input.createdByActor ?? row.ownerUserId
    row.createdByOnBehalfOf = input.createdByOnBehalfOf ?? row.ownerUserId
    // parentId handled after persist via reparent (edge-maintaining): the row
    // must be registered in this.store.rows first so wouldCycle/rowOrThrow work.
    let wire = this.store.persist(row)
    // New list MEMBERSHIP: single-issue deltas only patch known ids on legacy
    // clients, so a create still fans out the full list once (#22).
    this.store.broadcastList()
    this.store.emitEvent('issue.created', row.id, { seq: row.seq, title: row.title })
    if (input.parentId) wire = this.hierarchy().reparent(row.id, input.parentId)
    if (input.labels?.length) wire = this.setLabels(row.id, input.labels)
    return wire
  }

  /** Stage-machine normalization (issue #24) — the rules live in @podium/model's
   *  `normalizeClosedPatch` (see its doc for the three broken states it prevents). */
  private normalizeClosedPatch(row: IssueRow, patch: IssuePatch): IssuePatch {
    return normalizeClosedPatch(row, patch)
  }

  update(
    id: string,
    patch: IssuePatch,
    /** The session that initiated this mutation, when known (agent CLI relay).
     *  Threaded onto the issue.closed / issue.ready events it emits so the steward
     *  can skip nudging the very session that caused them (self-nudge is noise). */
    opts?: { actorSessionId?: string },
  ): IssueWire {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    const prevStage = row.stage
    const wasClosed = this.store.isClosed(row)
    patch = this.normalizeClosedPatch(row, patch)
    if (patch.defaultAgent !== undefined && patch.defaultAgent !== row.defaultAgent) {
      patch = {
        ...patch,
        ...(!('defaultModel' in patch) ? { defaultModel: 'auto' } : {}),
        ...(!('defaultEffort' in patch) ? { defaultEffort: 'auto' } : {}),
      } // [spec:SP-7ff1]
    }
    // Attention-state before-values (issue #124): every pin/defer/archive path funnels
    // through update() (dedicated methods just call it), so a single before/after diff
    // here is the one place these transitions are detected and their events emitted.
    const prevPinned = this.store.issueOverlay(row.id).pinned
    const prevArchived = row.archived
    const prevDeferUntil = row.deferUntil
    const prevParentBranch = row.parentBranch
    // Naming a draft promotes it to a real issue (issue-as-workspace).
    if (row.draft && typeof patch.title === 'string' && patch.title.trim()) row.draft = false
    // `pinned` is PER-USER (POD-1076) and must never reach `Object.assign` — that
    // is exactly how one person's pin became the issue's. It is split out first so
    // both branches below are assigning shared-row fields only.
    const { pinned: pinnedPatch, ...rowPatch } = patch
    if (pinnedPatch !== undefined) {
      // Re-pinning keeps the ORIGINAL stamp, same rule as the tuck-away.
      const prevPinnedAt = this.store.issueUserState(row.id)?.pinnedAt ?? null
      this.store.writeIssueUserState(row.id, {
        pinnedAt: pinnedPatch ? (prevPinnedAt ?? this.store.now()) : null,
      })
    }
    if ('parentId' in rowPatch) {
      this.hierarchy().setParentForUpdate(
        row,
        rowPatch.parentId == null ? null : this.store.resolveRef(rowPatch.parentId),
      )
      const { parentId: _ignored, ...rest } = rowPatch
      Object.assign(row, rest)
    } else {
      Object.assign(row, rowPatch)
    }
    // parentBranch is an INPUT to derived gitState. Mutating it without
    // re-probing leaves the old snapshot (computed against the old base)
    // describing a base that no longer applies — and the parent-branch sweep
    // cannot cover for it: retargeting changes the sweep's group key, so the
    // new group is first-seen and recorded without acting [POD-576].
    if (
      'parentBranch' in patch &&
      patch.parentBranch !== undefined &&
      row.parentBranch !== prevParentBranch
    ) {
      void this.gitWorkflow().refreshGitState(row.id).catch(() => {})
    }
    // Closed-flip anchor [spec:SP-6144]: closedAt moves ONLY on actual predicate
    // flips, so post-close touches (notes, deps, steward writes) never restart
    // the sidebar's completion-decay window the way updatedAt would.
    if (!wasClosed && this.store.isClosed(row)) row.closedAt = this.store.now()
    else if (wasClosed && !this.store.isClosed(row)) {
      row.closedAt = null
      // Reopening retires the dismissal (POD-333): reopened work must not inherit
      // a tuck from a PRIOR close, or the next time it finishes it would fold
      // itself away without the operator ever seeing it. A later close offers
      // Tuck away again. Cleared here — on the closed-predicate flip itself — so
      // every client converges on it through the same broadcast.
      this.store.writeIssueUserState(row.id, { tuckedAt: null })
    }
    // Organizational-only patches (pin / sortKey reorder) are not activity: do
    // not advance updatedAt past readAt or computeUnread re-marks the issue
    // unread after a purely human board edit (POD-325).
    const wire = this.store.persist(row, {
      touch: isOrganizationalOnlyPatch(patch) ? false : undefined,
    })
    // Cross-issue derived effects (#22): a closed-predicate flip changes the
    // dependents' blocked/ready and the parent's childDoneCount; a reparent
    // changes both parents' childCount. Those rows' wires must reach clients too.
    if (wasClosed !== this.store.isClosed(row) || 'parentId' in patch) this.store.broadcastList()
    // Transitions into done log as issue.closed below, not stage_changed.
    if (patch.stage != null && patch.stage !== prevStage && patch.stage !== 'done') {
      this.store.emitEvent('issue.stage_changed', row.id, {
        seq: row.seq,
        from: prevStage,
        to: patch.stage,
        // Carried so the steward's child→parent subscriptions (e.g. child→review)
        // stay pure over the event, like issue.closed already does.
        ...(row.parentId ? { parentId: row.parentId } : {}),
        // And so those nudges can skip the session that caused the transition (#116).
        ...(opts?.actorSessionId ? { causedBySessionId: opts.actorSessionId } : {}),
      })
    }
    // update() owns the closed/reopened emissions: EVERY close path funnels here
    // (close(), supersede/duplicate, board drag-to-done, CLI `update --stage done`).
    // Both derive from actual closed-predicate FLIPS: a same-state re-close stays
    // silent, while a close after a real reopen fires issue.closed again (#24 —
    // normalizeClosedPatch guarantees a reopen actually flips the predicate).
    if (wasClosed && !this.store.isClosed(row)) {
      this.store.emitEvent('issue.reopened', row.id, {
        seq: row.seq,
        ...(row.parentId ? { parentId: row.parentId } : {}),
        ...(opts?.actorSessionId ? { causedBySessionId: opts.actorSessionId } : {}),
      })
    }
    if (!wasClosed && this.store.isClosed(row)) {
      this.store.emitEvent('issue.closed', row.id, {
        seq: row.seq,
        reason: row.closedReason ?? 'done',
        // Carried so the steward's trigger rules stay pure over the event
        // (parent-nudge keys on parentId without a service lookup).
        ...(row.parentId ? { parentId: row.parentId } : {}),
        ...(opts?.actorSessionId ? { causedBySessionId: opts.actorSessionId } : {}),
      })
      // Closing completes the work: retire standing agent offers so a
      // delegate's "Merge / Send back" cannot demand a decision forever after
      // the coordinator finished through another session (POD-290).
      this.attention().retireIssueOffers(row)
      this.emitReadyAfterClose(row, opts?.actorSessionId)
      this.archiveClosedSubtree(row.id)
    }
    // Attention-state transitions S3 renders (issue #124). Emit only on an actual
    // change so a re-pin / re-archive / re-defer-to-same-time never duplicates.
    const nowPinned = this.store.issueOverlay(row.id).pinned
    if (nowPinned !== prevPinned) {
      this.store.emitEvent('issue.pinned', row.id, { seq: row.seq, pinned: nowPinned })
    }
    if (row.archived !== prevArchived && row.archived) {
      this.store.emitEvent('issue.archived', row.id, { seq: row.seq })
      // Stops the member sessions AND gives the checkout back (POD-567); the
      // sweep's own archive path calls the same seam.
      this.attention().onIssueArchived(row)
    }
    if (row.deferUntil !== prevDeferUntil) {
      if (row.deferUntil != null) {
        this.store.emitEvent('issue.snoozed', row.id, { seq: row.seq, until: row.deferUntil })
      } else {
        this.store.emitEvent('issue.unsnoozed', row.id, { seq: row.seq })
      }
    }
    return wire
  }

  /** Mark this issue read (issue #124): stamp read_at = now, persist + broadcast, and
   *  log issue.read. Derived `unread` in the wire flips to false immediately (readAt is
   *  now the latest timestamp). PER-USER STATE (POD-1076): the marker is written to
   *  the actor's `(userId, issueId)` row, not to the issue. */
  markIssueRead(id: string): IssueWire {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    this.store.writeIssueUserState(row.id, { readAt: this.store.now() })
    const wire = this.store.persist(row, { touch: false })
    this.store.emitEvent('issue.read', row.id, { seq: row.seq })
    return wire
  }

  /** Mark this issue UNREAD again (issue #138, the email-style inverse of
   *  markIssueRead): clear the marker so the derived `unread` (readAt null ⇒ unread)
   *  flips back to true, persist + broadcast, and log issue.unread. Mirrors
   *  markIssueRead exactly, on the actor's own `(userId, issueId)` row (POD-1076);
   *  marking MY copy unread never touches yours. */
  markIssueUnread(id: string): IssueWire {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    this.store.writeIssueUserState(row.id, { readAt: null })
    const wire = this.store.persist(row, { touch: false })
    this.store.emitEvent('issue.unread', row.id, { seq: row.seq })
    return wire
  }

  /** Tuck a finished issue away into the sidebar's Closed fold, or bring it back
   *  (POD-333). Persist + broadcast, so every connected client folds the row at
   *  the same moment and a fresh client hydrates the fold from server truth —
   *  this used to be a per-browser ui-state key, invisible to the server.
   *
   *  Curation, NOT activity: `touch: false`, exactly like markIssueRead — the
   *  dismissal must not advance updatedAt (which would restart the sidebar's
   *  completion decay and re-mark the issue unread). Tucking an OPEN issue is
   *  rejected rather than stored: the fold is for finished work, and a stamp
   *  parked on an open row would fire the moment it later closed. */
  setIssueTucked(id: string, tucked: boolean): IssueWire {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    if (tucked && !this.store.isClosed(row)) throw new Error(`issue ${id} is not finished`)
    // Re-tucking keeps the ORIGINAL stamp: a retried outbox entry (or a second
    // client pressing the same control) must not move the dismissal moment.
    // PER-USER (POD-1076): my fold is mine — tucking never hides your copy.
    const prev = this.store.issueOverlay(row.id).tuckedAt
    this.store.writeIssueUserState(row.id, { tuckedAt: tucked ? (prev ?? this.store.now()) : null })
    return this.store.persist(row, { touch: false })
  }

  /** Build the issue half of a cross-aggregate soft-delete without mutating
   *  memory before the durable transaction succeeds. */
  prepareSoftDelete(id: string, _remainingSessions: SessionMeta[]): IssueLifecyclePlan {
    id = this.store.resolveRef(id)
    const current = this.store.rowOrThrow(id)
    if (current.deletedAt) throw new Error(`issue ${id} is already deleted`)
    const deletedAt = this.store.now()
    const row: IssueRow = { ...current, deletedAt, updatedAt: deletedAt }
    // Projected INSIDE write(), after upsertIssue has stamped row.revision —
    // see IssueLifecyclePlan.wire for why taking it here would be a bug.
    let committed: IssueWire | null = null
    const wire = (): IssueWire => {
      if (!committed) {
        throw new Error(`prepareSoftDelete(${row.id}): wire() read before write() committed it`)
      }
      return committed
    }
    return {
      issueId: row.id,
      worktreePath: row.worktreePath,
      wire,
      write: () => {
        this.store.deps.store.issues.upsertIssue(row)
        committed = this.store.toWire(row)
      },
      changes: () => [{ entity: 'issue', id: row.id, op: 'upsert', value: wire() }],
      apply: () => {
        this.store.rows.set(row.id, row)
        this.store.emitEvent('issue.deleted', row.id, { seq: row.seq, deletedAt })
      },
      publish: () => this.store.broadcastList(),
    }
  }

  /** Permanently purge an automatically-created empty draft. User-facing deletion
   *  must go through IssueSessionLifecycle and never reaches this method.
   *
   *  `publish: false` commits and reloads but leaves the reconcile to the CALLER
   *  (POD-1638). The tail below serializes the FULL issue list, and the boot
   *  sweep purges in a loop — so publishing per draft republished the whole list
   *  once per reaped draft, on the event loop, at boot. A batching caller owes
   *  exactly one `issuesChanged(allWire())` afterwards; the default keeps every
   *  single-draft caller publishing its own, unchanged. */
  purgeEmptyDraft(ref: string, opts?: { publish?: boolean }): void {
    const id = this.store.resolveRef(ref)
    this.store.rowOrThrow(id)
    this.store.deps.ledger.commit({
      write: () => this.store.deps.store.issues.deleteIssue(id),
      changes: () => [{ entity: 'issue', id, op: 'remove' }],
    })
    this.store.reload()
    // The full-list tail reconciles BOTH kinds (POD-796), so the purge reaches
    // the normalized feed as the remove reconcile derives from full truth.
    // POD-1203 deleted the funnel snapshot half; `reconcileAndPublish` is the
    // whole tail now.
    if (opts?.publish !== false) {
      this.store.reconcileAndPublish(
        this.store.deps.publishSpecs.issuesChanged(this.store.allWire()),
      )
    }
    // Hard delete: drop any artifact snapshots too ([spec:SP-0fc9], best-effort).
    void this.store.deps.artifacts?.removeIssue(id).catch(() => {})
  }

  /** Build the issue half of a cross-aggregate restore without exposing the row
   *  before its issue and session tombstones have committed together. */
  prepareRestore(id: string, _restoredSessions: SessionMeta[]): IssueLifecyclePlan {
    id = this.store.resolveRef(id)
    const current = this.store.rowOrThrow(id)
    if (!current.deletedAt) throw new Error(`issue ${id} is not deleted`)
    const restoredAt = this.store.now()
    const row: IssueRow = { ...current, deletedAt: null, updatedAt: restoredAt }
    // Projected INSIDE write() — see prepareSoftDelete / IssueLifecyclePlan.wire.
    let committed: IssueWire | null = null
    const wire = (): IssueWire => {
      if (!committed) {
        throw new Error(`prepareRestore(${row.id}): wire() read before write() committed it`)
      }
      return committed
    }
    return {
      issueId: row.id,
      worktreePath: row.worktreePath,
      wire,
      write: () => {
        this.store.deps.store.issues.upsertIssue(row)
        committed = this.store.toWire(row)
      },
      changes: () => [{ entity: 'issue', id: row.id, op: 'upsert', value: wire() }],
      apply: () => {
        this.store.rows.set(row.id, row)
        this.store.emitEvent('issue.restored', row.id, { seq: row.seq, restoredAt })
      },
      publish: () => this.store.broadcastList(),
    }
  }

  setLabels(id: string, labels: string[]): IssueWire {
    id = this.store.resolveRef(id)
    const row = this.store.rowOrThrow(id)
    return this.store.persistWith(row, () =>
      this.store.deps.store.issues.setIssueLabels(id, labels),
    )
  }

  share(
    id: string,
    grantee: UserId,
    verb: GrantVerb,
    attribution: { actor: string; onBehalfOf: UserId },
  ): IssueWire {
    const row = this.store.rowOrThrow(this.store.resolveRef(id))
    if (!row.ownerUserId) throw new Error('issue has no accountable owner')
    const owner = row.ownerUserId
    const actorKind = attribution.actor.startsWith('session:')
      ? 'agent'
      : attribution.actor.startsWith('system:')
        ? 'system'
        : 'user'
    const actorId = attribution.actor.includes(':')
      ? attribution.actor.slice(attribution.actor.indexOf(':') + 1)
      : attribution.actor
    const wire = this.store.persistWith(row, () =>
      this.store.deps.store.grants.upsert({
        resourceKind: 'issue',
        resourceId: row.id,
        grantee,
        verb,
        owner,
        visibility: 'personal',
        createdAt: this.store.now(),
        ...(attribution ? { actor: attribution.actor, onBehalfOf: attribution.onBehalfOf } : {}),
        actorKind,
        actorId,
        onBehalfOf: attribution.onBehalfOf,
      }),
    )
    this.store.emitEvent('issue.shared', row.id, { grantee, verb, actor: attribution.actor })
    return wire
  }

  unshare(id: string, grantee: UserId, verb: GrantVerb): IssueWire {
    const row = this.store.rowOrThrow(this.store.resolveRef(id))
    const wire = this.store.persistWith(row, () =>
      this.store.deps.store.grants.remove('issue', row.id, grantee, verb),
    )
    this.store.emitEvent('issue.unshared', row.id, { grantee, verb })
    return wire
  }

  defer(id: string, until: string | null): IssueWire {
    return this.update(id, { deferUntil: until })
  }

  /** Manually end a snooze (issue #133). Rather than clearing deferUntil to null —
   *  which drops the issue quietly back into the middle of WORK with no signal — this
   *  backdates deferUntil to just-past, landing the issue in the exact "returned from
   *  defer" state a naturally-lapsed snooze reaches: derived `deferred`/`isIssueDeferred`
   *  go false while `issueReturnedFromDefer` goes true, floating it to the TOP of WORK
   *  with the "Unsnoozed" tag until the operator next opens it (the sidebar clears the
   *  stale defer on open). Emits issue.unsnoozed directly — routing a past deferUntil
   *  through update() would misfire issue.snoozed. No-op when the issue isn't deferred. */
  undefer(id: string): IssueWire {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    if (row.deferUntil == null) return this.store.toWire(row)
    row.deferUntil = new Date(Date.parse(this.store.now()) - UNSNOOZE_BACKDATE_MS).toISOString()
    const wire = this.store.persist(row)
    this.store.emitEvent('issue.unsnoozed', row.id, { seq: row.seq })
    return wire
  }

  setNeedsHuman(
    id: string,
    question?: string | null,
    /** Structured question metadata (issue #53): suggested answers for the Tray's
     *  answer chips + the asking session. askedAt is stamped here (now()) — a
     *  re-flag replaces the WHOLE pending question, metadata included. */
    meta?: { options?: string[]; askedBy?: SessionId },
  ): IssueWire {
    const wasFlagged = this.store.rows.get(this.store.resolveRef(id))?.needsHuman === true
    const options = meta?.options?.map((o) => o.trim()).filter(Boolean) ?? []
    const wire = this.update(id, {
      needsHuman: true,
      humanQuestion: question ?? null,
      humanQuestionOptions: options.length > 0 ? options : null,
      humanQuestionAskedBy: meta?.askedBy ?? null,
      humanQuestionAskedAt: this.store.now(),
    })
    // Emit only on the false→true flip — a re-flag must not duplicate the event.
    if (!wasFlagged) {
      const parentId = this.store.rows.get(wire.id)?.parentId
      this.store.emitEvent('issue.needs_human', wire.id, {
        seq: wire.seq,
        question: question ?? null,
        ...(options.length > 0 ? { options } : {}),
        ...(meta?.askedBy ? { askedBy: meta.askedBy } : {}),
        // Carried so a child needing a human can notify its parent's sessions.
        ...(parentId ? { parentId } : {}),
      })
    }
    return wire
  }

  clearNeedsHuman(id: string): IssueWire {
    const wasFlagged = this.store.rows.get(this.store.resolveRef(id))?.needsHuman === true
    const wire = this.update(id, {
      needsHuman: false,
      humanQuestion: null,
      humanQuestionOptions: null,
      humanQuestionAskedBy: null,
      humanQuestionAskedAt: null,
    })
    if (wasFlagged) this.store.emitEvent('issue.needs_human_cleared', wire.id, { seq: wire.seq })
    return wire
  }

  claim(id: string, assignee: UserId): IssueWire {
    return this.update(id, { assignee, stage: 'in_progress' })
  }

  /** Claim / set / clear the issue's designated coordinator session
   *  (docs/agent-comms-target.html §05 q1). Bare session id; null clears.
   *  Dangling-tolerant: we do not validate the session still exists — if it is
   *  later deleted, actionable mail falls back to selectMailNudgeSession. */
  setCoordinator(id: string, sessionId: SessionId | null): IssueWire {
    return this.update(id, { coordinatorSessionId: sessionId })
  }

  close(id: string, reason = 'done', opts?: { actorSessionId?: SessionId }): IssueWire {
    // update() emits issue.closed; actorSessionId rides through so the steward
    // can skip nudging the session that requested the close.
    return this.update(id, { stage: 'done', closedReason: reason }, opts)
  }

  applySuggestion(id: string): IssueWire {
    const row = this.store.rowOrThrow(id)
    const stage = row.suggestedStage
    row.suggestedStage = null
    row.suggestedReason = null
    // Route the stage move through update() so the #24 closed-state normalization
    // (and its closed/reopened event flips) applies — a suggested reopen must not
    // recreate the stage-only bimodal state. update() persists the cleared
    // suggestion fields along with the stage.
    if (stage) return this.update(row.id, { stage })
    return this.store.persistRow(row)
  }
  dismissSuggestion(id: string): IssueWire {
    const row = this.store.rowOrThrow(id)
    row.suggestedStage = null
    row.suggestedReason = null
    return this.store.persistRow(row)
  }
}
