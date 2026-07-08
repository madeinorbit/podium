import { randomUUID } from 'node:crypto'
import { normalizeClosedPatch } from '@podium/domain'
import type { IssueWire } from '@podium/protocol'
import type { IssueRow } from '../../../store'
import { IssueServiceReads } from './reads'
import type { CreateIssueInput, IssuePanelOp, IssuePatch } from './types'
import { UNSNOOZE_BACKDATE_MS } from './types'

/**
 * IssueService layer 2 — row mutations and the stage machine (issue #190 split):
 * create/update and every close/reopen path, dependency + hierarchy edits,
 * labels/comments/panel/state, and the attention-state event emissions that
 * update() detects. Every mutation ends in persist()/broadcastList() (core).
 */
export abstract class IssueServiceCrud extends IssueServiceReads {
  /** Cascade an archive onto member sessions — implemented by the attention
   *  layer (issue #133); update() detects the archive flip and calls it. */
  protected abstract cascadeArchiveSessions(row: IssueRow): void

  /** Agent-posted "where things stand" — writes activityNotes directly (the same
   *  field the assistant digest maintains; an explicit agent post is fresher truth
   *  and simply overwrites, and vice versa). Shown in the issue sidebar header. */
  setState(id: string, text: string): IssueWire {
    const row = this.rowOrThrow(id)
    row.activityNotes = text
    row.notesUpdatedAt = this.now()
    const wire = this.persist(row)
    this.emitEvent('issue.state', row.id, { seq: row.seq })
    return wire
  }

  /** Apply one mutation to an issue's agent-published human panel (right-sidebar
   *  "Issue" tab): human-facing todos, artifacts (files the user should look at),
   *  and deferred-work items awaiting a user decision. Indexes are 1-based (what
   *  the CLI prints). Persists + broadcasts like any other issue update. */
  panelApply(id: string, op: IssuePanelOp): IssueWire {
    const row = this.rowOrThrow(id)
    const panel = this.parsePanel(row)
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
        // Re-adding the same path replaces its entry (agents iterate on artifacts).
        panel.artifacts = panel.artifacts.filter((a) => a.path !== op.path)
        panel.artifacts.push({
          path: op.path,
          ...(op.title ? { title: op.title } : {}),
          addedAt: this.now(),
        })
        break
      }
      case 'artifact-remove':
        at(panel.artifacts, op.index)
        panel.artifacts.splice(op.index - 1, 1)
        break
      case 'deferred-add':
        panel.deferred.push({ text: op.text, addedAt: this.now() })
        break
      case 'deferred-remove':
        at(panel.deferred, op.index)
        panel.deferred.splice(op.index - 1, 1)
        break
    }
    row.panel = JSON.stringify(panel)
    const wire = this.persist(row)
    this.emitEvent('issue.panel', row.id, { seq: row.seq, op: op.op })
    return wire
  }

  /** Dependents of `closed` that its close just unblocked (their ONLY open blocker
   *  was `closed`): open rows in the same repo with a `blocks` dep on it whose wire
   *  `ready` is now true. Never throws — the close already persisted, and a sqlite
   *  read error in this fanout must not make the succeeded mutation look failed. */
  private emitReadyAfterClose(closed: IssueRow, actorSessionId?: string): void {
    try {
      const sessionList = this.deps.listSessions()
      const commentCounts = this.deps.store.countIssueCommentsByIssue()
      for (const r of this.rows.values()) {
        if (r.id === closed.id || !this.inRepoScope(r, closed.repoPath) || this.isClosed(r))
          continue
        const blocksClosed = this.deps.store
          .listIssueDeps(r.id)
          .some((d) => d.type === 'blocks' && d.toId === closed.id)
        if (blocksClosed && this.toWire(r, sessionList, commentCounts).ready) {
          this.emitEvent('issue.ready', r.id, {
            seq: r.seq,
            unblockedBy: closed.seq,
            ...(actorSessionId ? { causedBySessionId: actorSessionId } : {}),
          })
        }
      }
    } catch {}
  }

  create(input: CreateIssueInput): IssueWire {
    // Allocate the #N off the stable repo_id so all checkouts of one origin share a
    // single sequence (#140) — resolve the path to its repo_id first, then allocate.
    const repoId = this.deps.store.resolveRepoIdForPath(input.repoPath)
    const seq = this.deps.store.nextIssueSeq(repoId)
    const ts = this.now()
    const row: IssueRow = {
      id: input.id ?? `iss_${randomUUID()}`,
      repoPath: input.repoPath,
      repoId,
      seq,
      title: input.title,
      description: input.description ?? '',
      stage: 'backlog',
      worktreePath: null,
      branch: null,
      parentBranch:
        input.parentBranch || this.deps.getSettings().gitWorkflow.defaultParentBranch || 'main',
      defaultAgent:
        input.defaultAgent || this.deps.getSettings().sessionDefaults.agent || 'claude-code',
      defaultModel: input.defaultModel || this.deps.getSettings().sessionDefaults.model || 'auto',
      defaultEffort:
        input.defaultEffort || this.deps.getSettings().sessionDefaults.effort || 'auto',
      machineId: input.machineId ?? null,
      linearId: input.linear?.id ?? null,
      linearIdentifier: input.linear?.identifier ?? null,
      linearUrl: input.linear?.url ?? null,
      activityNotes: null,
      notesUpdatedAt: null,
      suggestedStage: null,
      suggestedReason: null,
      blockedBy: [],
      dependencyNote: null,
      prUrl: null,
      priority: 2,
      type: 'task',
      assignee: null,
      parentId: null,
      design: null,
      acceptance: null,
      notes: null,
      dueAt: null,
      deferUntil: null,
      closedReason: null,
      supersededBy: null,
      duplicateOf: null,
      pinned: false,
      estimateMin: null,
      needsHuman: false,
      humanQuestion: null,
      panel: null,
      createdAt: ts,
      updatedAt: ts,
      archived: false,
      origin: input.origin ?? 'human',
      draft: input.draft ?? false,
    }
    if (input.priority != null) row.priority = input.priority
    if (input.type) row.type = input.type
    if (input.assignee) row.assignee = input.assignee
    // parentId handled after persist via reparent (edge-maintaining): the row
    // must be registered in this.rows first so wouldCycle/rowOrThrow work.
    let wire = this.persist(row)
    // New list MEMBERSHIP: single-issue deltas only patch known ids on legacy
    // clients, so a create still fans out the full list once (#22).
    this.broadcastList()
    this.emitEvent('issue.created', row.id, { seq: row.seq, title: row.title })
    if (input.parentId) wire = this.reparent(row.id, input.parentId)
    if (input.labels?.length) wire = this.setLabels(row.id, input.labels)
    return wire
  }

  /** Stage-machine normalization (issue #24) — the rules live in @podium/domain's
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
    const row = this.rows.get(this.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    const prevStage = row.stage
    const wasClosed = this.isClosed(row)
    patch = this.normalizeClosedPatch(row, patch)
    // Attention-state before-values (issue #124): every pin/defer/archive path funnels
    // through update() (dedicated methods just call it), so a single before/after diff
    // here is the one place these transitions are detected and their events emitted.
    const prevPinned = row.pinned
    const prevArchived = row.archived
    const prevDeferUntil = row.deferUntil
    // Naming a draft promotes it to a real issue (issue-as-workspace).
    if (row.draft && typeof patch.title === 'string' && patch.title.trim()) row.draft = false
    if ('parentId' in patch) {
      this.setParent(row, patch.parentId == null ? null : this.resolveRef(patch.parentId))
      const { parentId: _ignored, ...rest } = patch
      Object.assign(row, rest)
    } else {
      Object.assign(row, patch)
    }
    const wire = this.persist(row)
    // Cross-issue derived effects (#22): a closed-predicate flip changes the
    // dependents' blocked/ready and the parent's childDoneCount; a reparent
    // changes both parents' childCount. Those rows' wires must reach clients too.
    if (wasClosed !== this.isClosed(row) || 'parentId' in patch) this.broadcastList()
    // Transitions into done log as issue.closed below, not stage_changed.
    if (patch.stage != null && patch.stage !== prevStage && patch.stage !== 'done') {
      this.emitEvent('issue.stage_changed', row.id, {
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
    if (wasClosed && !this.isClosed(row)) {
      this.emitEvent('issue.reopened', row.id, {
        seq: row.seq,
        ...(row.parentId ? { parentId: row.parentId } : {}),
        ...(opts?.actorSessionId ? { causedBySessionId: opts.actorSessionId } : {}),
      })
    }
    if (!wasClosed && this.isClosed(row)) {
      this.emitEvent('issue.closed', row.id, {
        seq: row.seq,
        reason: row.closedReason ?? 'done',
        // Carried so the steward's trigger rules stay pure over the event
        // (parent-nudge keys on parentId without a service lookup).
        ...(row.parentId ? { parentId: row.parentId } : {}),
        ...(opts?.actorSessionId ? { causedBySessionId: opts.actorSessionId } : {}),
      })
      this.emitReadyAfterClose(row, opts?.actorSessionId)
    }
    // Attention-state transitions S3 renders (issue #124). Emit only on an actual
    // change so a re-pin / re-archive / re-defer-to-same-time never duplicates.
    if (row.pinned !== prevPinned) {
      this.emitEvent('issue.pinned', row.id, { seq: row.seq, pinned: row.pinned })
    }
    if (row.archived !== prevArchived && row.archived) {
      this.emitEvent('issue.archived', row.id, { seq: row.seq })
      this.cascadeArchiveSessions(row)
    }
    if (row.deferUntil !== prevDeferUntil) {
      if (row.deferUntil != null) {
        this.emitEvent('issue.snoozed', row.id, { seq: row.seq, until: row.deferUntil })
      } else {
        this.emitEvent('issue.unsnoozed', row.id, { seq: row.seq })
      }
    }
    return wire
  }

  /** Mark this issue read (issue #124): stamp read_at = now, persist + broadcast, and
   *  log issue.read. Derived `unread` in the wire flips to false immediately (readAt is
   *  now the latest timestamp). Read state is GLOBAL — single-operator, no per-user row. */
  markIssueRead(id: string): IssueWire {
    const row = this.rows.get(this.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    row.readAt = this.now()
    const wire = this.persist(row)
    this.emitEvent('issue.read', row.id, { seq: row.seq })
    return wire
  }

  /** Mark this issue UNREAD again (issue #138, the email-style inverse of
   *  markIssueRead): clear read_at so the derived `unread` (readAt null ⇒ unread)
   *  flips back to true, persist + broadcast, and log issue.unread. Mirrors
   *  markIssueRead exactly; read state stays GLOBAL (single-operator, no per-user row). */
  markIssueUnread(id: string): IssueWire {
    const row = this.rows.get(this.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    row.readAt = null
    const wire = this.persist(row)
    this.emitEvent('issue.unread', row.id, { seq: row.seq })
    return wire
  }

  delete(id: string): void {
    id = this.resolveRef(id)
    this.rowOrThrow(id)
    this.deps.store.deleteIssue(id)
    // Re-hydrate from the store: deleteIssue also clears scalar back-refs
    // (parent_id / superseded_by / duplicate_of) on OTHER rows, so a plain
    // map delete would leave those stale pointers in the broadcast.
    this.reload()
    this.deps.broadcast({ type: 'issuesChanged', issues: this.allWire() })
  }

  setLabels(id: string, labels: string[]): IssueWire {
    id = this.resolveRef(id)
    const row = this.rowOrThrow(id)
    this.deps.store.setIssueLabels(id, labels)
    return this.persist(row)
  }

  addComment(id: string, author: string, body: string): IssueWire {
    id = this.resolveRef(id)
    const row = this.rowOrThrow(id)
    this.deps.store.addIssueComment({
      id: `cmt_${randomUUID()}`,
      issueId: id,
      author,
      body,
      createdAt: this.now(),
    })
    return this.persist(row)
  }

  /** Cycle check over `blocks` edges + the parent link (synthesized from
   *  issues.parent_id — single parent storage, #164), following from->to. */
  private wouldCycle(fromId: string, toId: string): boolean {
    const seen = new Set<string>()
    const stack = [toId]
    while (stack.length) {
      const cur = stack.pop() as string
      if (cur === fromId) return true
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const d of this.deps.store.listIssueDeps(cur)) {
        if (d.type === 'blocks') stack.push(d.toId)
      }
      const parentId = this.rows.get(cur)?.parentId
      if (parentId) stack.push(parentId)
    }
    return false
  }

  addDep(fromId: string, toId: string, type = 'blocks'): IssueWire {
    // The hierarchy lives ONLY in issues.parent_id (#164) — reparent owns it.
    // Reject the type here so an arbitrary-type caller can't reintroduce
    // parent-child rows into issue_deps.
    if (type === 'parent-child') throw new Error('parent-child is managed by reparent, not addDep')
    fromId = this.resolveRef(fromId)
    toId = this.resolveRef(toId)
    const row = this.rowOrThrow(fromId)
    this.rowOrThrow(toId)
    if (fromId === toId) throw new Error('an issue cannot depend on itself (self-dep)')
    if (type === 'blocks' && this.wouldCycle(fromId, toId)) {
      throw new Error(`dependency ${fromId} -> ${toId} would create a cycle`)
    }
    this.deps.store.addIssueDep(fromId, toId, type)
    const wire = this.persist(row)
    this.broadcastList() // the TARGET's dependents/blocked derivation changed too (#22)
    return wire
  }

  removeDep(fromId: string, toId: string, type?: string): IssueWire {
    // The hierarchy lives ONLY in issues.parent_id (#164) — reparent owns it,
    // and no parent-child rows exist in issue_deps for the bulk path to guard.
    if (type === 'parent-child')
      throw new Error('parent-child is managed by reparent, not removeDep')
    fromId = this.resolveRef(fromId)
    toId = this.resolveRef(toId)
    const row = this.rowOrThrow(fromId)
    this.deps.store.removeIssueDep(fromId, toId, type)
    const wire = this.persist(row)
    this.broadcastList() // the TARGET's dependents/blocked derivation changed too (#22)
    return wire
  }

  defer(id: string, until: string | null): IssueWire {
    return this.update(id, { deferUntil: until })
  }

  /** Manually end a snooze (issue #133). Rather than clearing deferUntil to null —
   *  which drops the issue quietly back into the middle of WORK with no signal — this
   *  backdates deferUntil to just-past, landing the issue in the exact "returned from
   *  defer" state a naturally-lapsed snooze reaches: derived `deferred`/`isIssueSnoozed`
   *  go false while `issueReturnedFromDefer` goes true, floating it to the TOP of WORK
   *  with the "Unsnoozed" tag until the operator next opens it (the sidebar clears the
   *  stale defer on open). Emits issue.unsnoozed directly — routing a past deferUntil
   *  through update() would misfire issue.snoozed. No-op when the issue isn't deferred. */
  undefer(id: string): IssueWire {
    const row = this.rows.get(this.resolveRef(id))
    if (!row) throw new Error(`unknown issue ${id}`)
    if (row.deferUntil == null) return this.toWire(row)
    row.deferUntil = new Date(Date.parse(this.now()) - UNSNOOZE_BACKDATE_MS).toISOString()
    const wire = this.persist(row)
    this.emitEvent('issue.unsnoozed', row.id, { seq: row.seq })
    return wire
  }

  setNeedsHuman(id: string, question?: string | null): IssueWire {
    const wasFlagged = this.rows.get(this.resolveRef(id))?.needsHuman === true
    const wire = this.update(id, { needsHuman: true, humanQuestion: question ?? null })
    // Emit only on the false→true flip — a re-flag must not duplicate the event.
    if (!wasFlagged) {
      this.emitEvent('issue.needs_human', wire.id, {
        seq: wire.seq,
        question: question ?? null,
        // Carried so a child needing a human can notify its parent's sessions.
        ...(this.rows.get(wire.id)?.parentId ? { parentId: this.rows.get(wire.id)!.parentId } : {}),
      })
    }
    return wire
  }

  clearNeedsHuman(id: string): IssueWire {
    const wasFlagged = this.rows.get(this.resolveRef(id))?.needsHuman === true
    const wire = this.update(id, { needsHuman: false, humanQuestion: null })
    if (wasFlagged) this.emitEvent('issue.needs_human_cleared', wire.id, { seq: wire.seq })
    return wire
  }

  /** The single cycle-checked reparent path. issues.parent_id is the ONLY
   *  parent storage (#164 — the mirrored 'parent-child' issue_deps rows are
   *  gone; graph/tree/cycle consumers synthesize the edge from the column).
   *  Mutates row.parentId; caller persists. wouldCycle returns true the
   *  instant it reaches row.id (before expanding that node), so row's
   *  still-current old parent link is never traversed and can't skew it. */
  private setParent(row: IssueRow, newParentId: string | null): void {
    if (newParentId === row.parentId) return
    if (newParentId) {
      this.rowOrThrow(newParentId)
      if (newParentId === row.id || this.wouldCycle(row.id, newParentId)) {
        throw new Error(`reparent ${row.id} -> ${newParentId} would create a cycle`)
      }
    }
    row.parentId = newParentId
  }

  reparent(id: string, parentId: string | null): IssueWire {
    const row = this.rowOrThrow(id)
    this.setParent(row, parentId == null ? null : this.resolveRef(parentId))
    const wire = this.persist(row)
    this.broadcastList() // both parents' childCount/childDoneCount changed (#22)
    return wire
  }

  /** The issue's parent chain, nearest first. Cycle-safe (parent graph is invariant, but
   *  guard anyway). Used by the authz middleware to test subtree membership. */
  ancestorIds(id: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    let cur = this.rows.get(this.resolveRef(id))?.parentId ?? null
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      out.push(cur)
      cur = this.rows.get(cur)?.parentId ?? null
    }
    return out
  }

  claim(id: string, assignee: string): IssueWire {
    return this.update(id, { assignee, stage: 'in_progress' })
  }

  close(id: string, reason = 'done', opts?: { actorSessionId?: string }): IssueWire {
    // update() emits issue.closed; actorSessionId rides through so the steward
    // can skip nudging the session that requested the close.
    return this.update(id, { stage: 'done', closedReason: reason }, opts)
  }

  supersede(oldId: string, newId: string): IssueWire {
    oldId = this.resolveRef(oldId)
    newId = this.resolveRef(newId)
    this.rowOrThrow(newId)
    this.addDep(oldId, newId, 'supersedes')
    return this.update(oldId, { stage: 'done', closedReason: 'superseded', supersededBy: newId })
  }

  duplicate(id: string, canonicalId: string): IssueWire {
    id = this.resolveRef(id)
    canonicalId = this.resolveRef(canonicalId)
    this.rowOrThrow(canonicalId)
    this.addDep(id, canonicalId, 'related')
    return this.update(id, { stage: 'done', closedReason: 'duplicate', duplicateOf: canonicalId })
  }

  applySuggestion(id: string): IssueWire {
    const row = this.rowOrThrow(id)
    const stage = row.suggestedStage
    row.suggestedStage = null
    row.suggestedReason = null
    // Route the stage move through update() so the #24 closed-state normalization
    // (and its closed/reopened event flips) applies — a suggested reopen must not
    // recreate the stage-only bimodal state. update() persists the cleared
    // suggestion fields along with the stage.
    if (stage) return this.update(row.id, { stage })
    return this.persistRow(row)
  }
  dismissSuggestion(id: string): IssueWire {
    const row = this.rowOrThrow(id)
    row.suggestedStage = null
    row.suggestedReason = null
    return this.persistRow(row)
  }
}
