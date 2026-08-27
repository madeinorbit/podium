import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  type ArtifactId,
  asIssueId,
  asRepoId,
  asSessionId,
  asUserId,
  canonicalIssueCloseReason,
  type GrantVerb,
  type IssueId,
  type IssueWire,
  isIssueStage,
  isSortKey,
  isSystemOwnedIssueStage,
  normalizeClosedPatch,
  type RepoId,
  type SessionId,
  type SessionMeta,
  SORT_KEY_COMPACT_LEN,
  sortKeyBetween,
  spreadSortKeys,
  type UserId,
} from '@podium/model'
import { resolveSpawnDefaults } from '@podium/runtime'
import type { EntityChangeSpec } from '@podium/sync'
import type { IssueRow } from '../../../store'
import { type StoredIssue, toStorage } from '../../../store/issue-storage'
import { findSessionById } from '../../sessions/session-by-id'
import type { IssueStore } from './core'
import { IssueNotFound } from './not-found'
import type { CreateIssueInput, IssuePanelOp, IssuePatch } from './types'
import { UNSNOOZE_BACKDATE_MS } from './types'
import { sameWorktreePath } from './worktree-safety'

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

/**
 * Cap on a SINGLE artifact read served as one command result (POD-1999). The
 * store itself admits files up to 100MB, but a command result travels as
 * base64 inside one JSON envelope over both transports — so past this size the
 * answer is the URL, which streams, rather than the bytes. The refusal names
 * that URL so the caller is never left without a way through.
 */
export const ARTIFACT_READ_CAP_BYTES = 16 * 1024 * 1024

/** The server-local route that serves the same snapshot as a stream — the path
 *  `file-artifact-route.ts` registers. Relative, because the caller knows which
 *  server it is talking to and the server does not know its own public origin. */
function artifactUrl(issueId: IssueId, artifactId: string, file: string): string {
  const rel = file.split('/').map(encodeURIComponent).join('/')
  return `/files/artifact/${issueId}/${artifactId}/${rel}`
}

/** One artifact's stored content, as `panelArtifactRead` answers it. */
export interface IssueArtifactContent {
  /** 1-based position in the issue's artifact list — what the CLI prints. */
  index: number
  /** Source path the artifact was added from. */
  path: string
  title?: string
  addedAt: string
  artifactId: ArtifactId
  /** Primary file of the snapshot bundle. */
  entry: string
  files: { path: string; size: number }[]
  /** Relpath actually read (`entry` unless the caller asked for another). */
  file: string
  contentType: string
  size: number
  /** Streaming alternative to `dataBase64`, on the same server. */
  url: string
  dataBase64: string
}

/** Prepared half of the atomic issue/session lifecycle transaction. */
export interface IssueLifecyclePlan {
  issueId: IssueId
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

/** Internal custody mutation used only by the shipping control plane. The
 * normalized repository write and its compact shipOrder row ride the same
 * outer Ledger transaction as any issue stage/attention change. */
export interface ShippingIssueMutation {
  expectedStage: 'review' | 'shipping' | 'done' | readonly ('review' | 'shipping' | 'done')[]
  nextStage?: 'shipping' | 'review' | 'done'
  nextStageForResult?: (result: unknown) => 'shipping' | 'review' | 'done' | undefined
  needsHuman?: boolean
  shipOrderChanges: readonly EntityChangeSpec[] | ((result: unknown) => readonly EntityChangeSpec[])
  event?:
    | { kind: string; payload: Record<string, unknown> }
    | ((result: unknown) => { kind: string; payload: Record<string, unknown> } | undefined)
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

  shippingCommit<T>(
    id: IssueId,
    mutation: ShippingIssueMutation,
    write: () => T,
  ): { issue: IssueWire; result: T } {
    const row = this.store.rowOrThrow(this.store.resolveRef(id))
    const expectedStages = Array.isArray(mutation.expectedStage)
      ? mutation.expectedStage
      : [mutation.expectedStage]
    const needsHumanBefore = row.needsHuman
    let result: T | undefined
    const issue = this.store.persistWith(
      row,
      () => {
        if (!(expectedStages as readonly string[]).includes(row.stage)) {
          throw new Error(
            `issue ${row.id} shipping stage fence failed: expected ${expectedStages.join(' or ')}`,
          )
        }
        result = write()
        const nextStage = mutation.nextStageForResult?.(result as T) ?? mutation.nextStage
        if (nextStage) {
          const legal =
            (row.stage === 'review' && nextStage === 'shipping') ||
            (row.stage === 'shipping' &&
              (nextStage === 'review' || nextStage === 'done' || nextStage === 'shipping'))
          if (!legal) {
            throw new Error(`illegal shipping issue-stage transition ${row.stage} → ${nextStage}`)
          }
          row.stage = nextStage
        }
        if (mutation.needsHuman !== undefined) {
          row.needsHuman = mutation.needsHuman
          // A ship hold is typed on ShipOrderProjection, never a fake session question.
          row.humanQuestion = null
          row.humanQuestionOptions = null
          row.humanQuestionAskedBy = null
          row.humanQuestionAskedAt = null
        }
      },
      {
        extraChanges: () =>
          typeof mutation.shipOrderChanges === 'function'
            ? mutation.shipOrderChanges(result as T)
            : mutation.shipOrderChanges,
      },
    )
    const event =
      typeof mutation.event === 'function' ? mutation.event(result as T) : mutation.event
    if (event) this.store.emitEvent(event.kind, row.id, event.payload)
    if (!needsHumanBefore && mutation.needsHuman === true) {
      this.store.emitEvent('issue.needs_human', row.id, { seq: row.seq, kind: 'ship-hold' })
    } else if (needsHumanBefore && mutation.needsHuman === false) {
      this.store.emitEvent('issue.needs_human_cleared', row.id, {
        seq: row.seq,
        kind: 'ship-hold',
      })
    }
    return { issue, result: result as T }
  }

  shippingCommitMany<T>(
    entries: readonly { id: IssueId; mutation: ShippingIssueMutation }[],
    write: () => T,
  ): { issues: IssueWire[]; result: T } {
    if (entries.length === 0) throw new Error('shipping batch requires an affected issue')
    const rows = entries.map(({ id }) => this.store.rowOrThrow(this.store.resolveRef(id)))
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      throw new Error('shipping batch contains a duplicate issue')
    }
    const needsHumanBefore = new Map(rows.map((row) => [row.id, row.needsHuman] as const))
    for (const [index, row] of rows.entries()) {
      const mutation = entries[index]!.mutation
      const expectedStages = Array.isArray(mutation.expectedStage)
        ? mutation.expectedStage
        : [mutation.expectedStage]
      if (!(expectedStages as readonly string[]).includes(row.stage)) {
        throw new Error(
          `issue ${row.id} shipping stage fence failed: expected ${expectedStages.join(' or ')}`,
        )
      }
      const nextStage = mutation.nextStage
      if (nextStage) {
        const legal =
          (row.stage === 'review' && nextStage === 'shipping') ||
          (row.stage === 'shipping' &&
            (nextStage === 'review' || nextStage === 'done' || nextStage === 'shipping'))
        if (!legal) {
          throw new Error(`illegal shipping issue-stage transition ${row.stage} → ${nextStage}`)
        }
      }
    }
    for (const [index, row] of rows.entries()) {
      const mutation = entries[index]!.mutation
      if (mutation.nextStage) row.stage = mutation.nextStage
      if (mutation.needsHuman === undefined) continue
      row.needsHuman = mutation.needsHuman
      row.humanQuestion = null
      row.humanQuestionOptions = null
      row.humanQuestionAskedBy = null
      row.humanQuestionAskedAt = null
    }
    const committed = this.store.persistManyWith(
      rows,
      write,
      (result) => {
        const changes = entries.flatMap(({ mutation }) =>
          typeof mutation.shipOrderChanges === 'function'
            ? mutation.shipOrderChanges(result)
            : mutation.shipOrderChanges,
        )
        return [
          ...new Map(changes.map((change) => [`${change.entity}:${change.id}`, change])).values(),
        ]
      },
      (result) =>
        entries.flatMap(({ mutation }, index) => {
          const row = rows[index]!
          const event =
            typeof mutation.event === 'function' ? mutation.event(result) : mutation.event
          const attention =
            !needsHumanBefore.get(row.id) && mutation.needsHuman === true
              ? {
                  kind: 'issue.needs_human',
                  subject: row.id,
                  payload: { seq: row.seq, kind: 'ship-hold' },
                }
              : needsHumanBefore.get(row.id) && mutation.needsHuman === false
                ? {
                    kind: 'issue.needs_human_cleared',
                    subject: row.id,
                    payload: { seq: row.seq, kind: 'ship-hold' },
                  }
                : undefined
          return [
            ...(event ? [{ ...event, subject: row.id }] : []),
            ...(attention ? [attention] : []),
          ]
        }),
    )
    return committed
  }

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
          ...(op.sourcePaths ? { sourcePaths: op.sourcePaths } : {}),
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
    opts?: { actorSessionId?: SessionId },
  ): Promise<IssueWire> {
    const row = this.store.rowOrThrow(this.store.resolveRef(id))
    const store = this.store.deps.artifacts
    // Evidence belongs to the ISSUE worktree, never whichever checkout happened
    // to invoke the command. The old session-cwd fallback let a parent review
    // silently point into a child's checkout (or a scratch directory).
    const root = row.worktreePath
    if (!root) {
      throw new Error(
        `issue ${row.seq} has no owning worktree; start or restore its worktree before adding review artifacts`,
      )
    }
    const normalizeSource = (sourcePath: string): string => {
      const target = resolve(root, sourcePath)
      const rel = relative(resolve(root), target)
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(
          `artifact path '${sourcePath}' is outside the owning issue worktree ${root}`,
        )
      }
      return rel.split(sep).join('/')
    }
    const sourcePath = normalizeSource(input.path)
    const extraPaths = input.extraPaths?.map(normalizeSource)
    // Re-add keeps the existing title unless a new one is given.
    const existing = this.store.parsePanel(row).artifacts.find((a) => a.path === sourcePath)
    const effectiveTitle = input.title ?? existing?.title
    const title = effectiveTitle ? { title: effectiveTitle } : {}
    if (!store) {
      return this.panelApply(row.id, {
        op: 'artifact-add',
        path: sourcePath,
        ...title,
        sourcePaths: [sourcePath, ...(extraPaths ?? [])],
      })
    }
    // Owning machine is the issue's machine; the invoking session is only a
    // fallback for old rows that predate a machine pin.
    const session = opts?.actorSessionId
      ? findSessionById(this.store.deps, opts.actorSessionId)
      : undefined
    const machineId = row.machineId ?? session?.machineId ?? undefined
    const snap = await store.snapshot({
      issueId: row.id,
      root,
      ...(machineId ? { machineId } : {}),
      sourcePath,
      ...(extraPaths?.length ? { extraPaths } : {}),
    })
    const sourcePaths = [...new Set(snap.sourcePaths ?? [sourcePath, ...(extraPaths ?? [])])]
    const oldId = existing?.artifactId
    const wire = this.panelApply(row.id, {
      op: 'artifact-add',
      path: sourcePath,
      ...title,
      artifactId: snap.artifactId,
      entry: snap.entry,
      files: snap.files,
      sourcePaths,
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

  /**
   * READ ONE ARTIFACT'S STORED BYTES BACK (POD-1999, [spec:SP-0fc9]).
   *
   * `panelArtifactAdd` snapshots the bytes into the server's permanent store and
   * the panel then only carries the source path — so an agent that did not
   * create the artifact (or created it in a worktree that is now gone) could see
   * that it exists and not open it. This serves the SNAPSHOT, not the source: it
   * reads the server's own disk, so the answer does not depend on the authoring
   * machine being reachable, which is what makes it work for a daemon that is
   * not the server's.
   *
   * Selection is by 1-based `index` (what the CLI prints) or by source `path`.
   * `file` picks one member of a bundle; omitted, the bundle's entry file wins.
   */
  async panelArtifactRead(
    id: string,
    input: { index?: number; path?: string; file?: string },
  ): Promise<IssueArtifactContent> {
    const row = this.store.rowOrThrow(this.store.resolveRef(id))
    const artifacts = this.store.parsePanel(row).artifacts
    if (artifacts.length === 0) throw new Error('this issue has no artifacts')
    const at =
      input.index != null
        ? input.index - 1
        : input.path != null
          ? artifacts.findIndex((a) => a.path === input.path)
          : -1
    if (input.index == null && input.path == null) {
      throw new Error('name the artifact to read: an index or a path')
    }
    const entryRow = at >= 0 ? artifacts[at] : undefined
    if (!entryRow) {
      throw new Error(
        input.path != null
          ? `no artifact with path ${input.path} (issue has ${artifacts.length})`
          : `no artifact ${input.index} (issue has ${artifacts.length})`,
      )
    }
    const store = this.store.deps.artifacts
    // A pre-snapshot entry (or a deployment with no store wired) has a path and
    // nothing behind it — say so rather than 404ing as if the file were missing.
    if (!store || !entryRow.artifactId) {
      throw new Error(
        `artifact ${at + 1} (${entryRow.path}) has no stored snapshot — re-add it ` +
          'with `podium issue artifact <id> --add <path>` to capture its content',
      )
    }
    const file = input.file ?? entryRow.entry ?? entryRow.path.split('/').pop() ?? entryRow.path
    const found = await store.read(row.id, entryRow.artifactId, file)
    if (!found) {
      const known = (entryRow.files ?? []).map((f) => f.path).join(', ')
      throw new Error(
        `artifact ${at + 1} has no stored file ${file}${known ? ` (bundle holds: ${known})` : ''}`,
      )
    }
    if (found.bytes.length > ARTIFACT_READ_CAP_BYTES) {
      throw new Error(
        `${file} is ${found.bytes.length} bytes — over the ${
          ARTIFACT_READ_CAP_BYTES / (1024 * 1024)
        }MB command-read cap; fetch it from the server at ${artifactUrl(row.id, entryRow.artifactId, file)}`,
      )
    }
    return {
      index: at + 1,
      path: entryRow.path,
      ...(entryRow.title ? { title: entryRow.title } : {}),
      addedAt: entryRow.addedAt,
      artifactId: entryRow.artifactId,
      entry: entryRow.entry ?? file,
      files: entryRow.files ?? [{ path: file, size: found.bytes.length }],
      file,
      contentType: found.contentType,
      size: found.bytes.length,
      url: artifactUrl(row.id, entryRow.artifactId, file),
      dataBase64: found.bytes.toString('base64'),
    }
  }

  /** Dependents of `closed` that its close just unblocked (their ONLY open blocker
   *  was `closed`): open rows in the same repo with a `blocks` dep on it whose wire
   *  `ready` is now true. Never throws — the close already persisted, and a sqlite
   *  read error in this fanout must not make the succeeded mutation look failed. */
  private emitReadyAfterClose(closed: IssueRow, actorSessionId?: SessionId): void {
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
      // Close-sweep must not take the explicit-archive descendant walk: an
      // open grandchild of a qualifying child has to stay live. The operator
      // archive path below is the one that dismisses the whole subtree.
      this.update(child.id, { archived: true }, { cascadeArchive: false })
    }
    if (skipped.length) {
      const parent = this.store.rows.get(parentId)
      if (parent) {
        this.store.emitEvent('issue.cascade_skipped', parentId, { seq: parent.seq, skipped })
      }
    }
  }

  /** Explicit archive of a parent dismisses every living descendant. Unlike
   *  {@link archiveClosedSubtree}, open / unread / live-session children are
   *  not spared: the operator hid the container, and leaving those children
   *  independently visible is how they resurface as "new" work. Recurses
   *  through each child's own `update({ archived: true })` so session teardown
   *  and events stay on the same path as a direct archive. */
  private archiveLivingDescendants(parentId: string): void {
    for (const child of this.store.rows.values()) {
      if (child.parentId !== parentId || child.archived || child.deletedAt) continue
      this.update(child.id, { archived: true })
    }
  }

  /**
   * Every non-deleted row sharing ONE manual-order key space (POD-168): a
   * parent's children when parentId is set, else the repo's top level.
   *
   * Archived rows are in it. They still hold keys, and a scope measured over a
   * narrower set than it renumbers compacts into a state that immediately reads
   * as long again.
   *
   * PINNED IS A DIFFERENT ANSWER FOR THE TWO CALLERS, and getting that wrong is
   * what a whole-scope renumber punishes (POD-1102):
   *
   *  - MINTING skips pinned rows. A pin lifts the row into its own section, and
   *    letting it hold the mint point would key every new issue against a row
   *    that is no longer in the list they appear at the top of.
   *  - COMPACTION must not. Pin/unpin deliberately leaves `sortKey` untouched so
   *    unpinning returns the row to its old position — which only works while
   *    pinned and unpinned rows are comparable. Renumber one and not the other
   *    and every pinned row keeps a long key, sorts above the short new ones,
   *    and comes back from the pin in the wrong place. A total order restricted
   *    to a subset preserves that subset's order, so renumbering the UNION keeps
   *    both the pinned section's internal order and the list's.
   */
  private sortScopeRows(
    repoId: RepoId | null | undefined,
    repoPath: string,
    parentId: string | null,
    opts?: { includePinned?: boolean },
  ): IssueRow[] {
    const rows: IssueRow[] = []
    for (const r of this.store.rows.values()) {
      if (r.deletedAt) continue
      const sameScope = parentId
        ? r.parentId === parentId
        : r.parentId == null &&
          (opts?.includePinned === true || !this.store.issueOverlay(r.id).pinned) &&
          (r.repoId ? r.repoId === repoId : r.repoPath === repoPath)
      if (sameScope) rows.push(r)
    }
    return rows
  }

  /** The rows a compaction of this scope must renumber — the whole key space,
   *  pinned rows included. See {@link sortScopeRows}. */
  private sortKeySpaceRows(
    repoId: RepoId | null | undefined,
    repoPath: string,
    parentId: string | null,
  ): IssueRow[] {
    return this.sortScopeRows(repoId, repoPath, parentId, { includePinned: true })
  }

  /** The scope's current top key, corrupt/legacy keys ignored. */
  private minSortKey(scope: readonly IssueRow[]): string | null {
    let min: string | null = null
    for (const r of scope) {
      const k = r.sortKey
      if (isSortKey(k) && (min === null || k < min)) min = k
    }
    return min
  }

  /**
   * Renumber a whole key space with fresh evenly-spread keys, in the order it
   * already renders (POD-1102).
   *
   * NOT A REPAIR OF CORRUPTION — the keys being replaced are perfectly valid,
   * just LONG. `mintSortKey` puts every new row above the scope's minimum, so a
   * repo that keeps making work keeps pushing its own top key down toward zero:
   * one character longer every five creates, forever. The growth is silent,
   * because the writer doing it mints server-side inside this service where no
   * schema is checked — and the only party a length limit could ever refuse is
   * the DRAG, whose key merely inherited the scope's history.
   *
   * Ordering is read back off the rows rather than passed in, so this stays
   * callable from anywhere the scope is known: valid keys ascending first (the
   * manual order), then unkeyed legacy rows in creation order, newest first —
   * the same fallback `compareManualOrder` uses on the client, so a compaction
   * FREEZES the order the operator is looking at instead of reshuffling it.
   *
   * ONE COMMIT FOR THE WHOLE SCOPE, and that is not a micro-optimisation. Row by
   * row through `persist`, this workspace's 921-row space took EIGHT SECONDS —
   * measured — because each row paid its own transaction, its own `toWire` and
   * its own change append. Batched, the same repair is ~2s.
   */
  private compactSortKeys(scope: readonly IssueRow[]): void {
    const ordered = [...scope].sort((a, b) => {
      const ka = isSortKey(a.sortKey) ? a.sortKey : null
      const kb = isSortKey(b.sortKey) ? b.sortKey : null
      if (ka !== null && kb !== null && ka !== kb) return ka < kb ? -1 : 1
      if (ka !== null && kb === null) return -1
      if (ka === null && kb !== null) return 1
      const dt = Date.parse(b.createdAt) - Date.parse(a.createdAt)
      if (dt) return dt
      if (a.seq !== b.seq) return b.seq - a.seq
      return a.id.localeCompare(b.id)
    })
    const keys = spreadSortKeys(ordered.length)
    const changed: IssueRow[] = []
    for (const [i, row] of ordered.entries()) {
      const next = keys[i]
      if (next === undefined || row.sortKey === next) continue
      row.sortKey = next
      changed.push(row)
    }
    if (changed.length === 0) return
    // `touch: false` for the same reason the reorder itself carries it: a scope
    // repair is organizational, and stamping `updatedAt` across a repo would
    // mark every issue in it unread (POD-325).
    this.store.persistManyWith(
      changed,
      () => undefined,
      () => [],
      () => [],
      { touch: false },
    )
  }

  /** Mint a manual-order key ABOVE the sibling scope's current top (POD-168):
   *  "new appears at top" (R2) is the sort's natural behavior, no special case.
   *  Compacts first when the scope's top key has grown long enough that another
   *  head-insert would push it toward the wire cap (POD-1102) — see
   *  {@link compactSortKeys} for why an ever-growing key breaks the DRAG rather
   *  than the create that grew it. */
  private mintSortKey(repoId: RepoId, repoPath: string, parentId: string | null): string {
    // Measured over the unpinned rows, renumbered over the whole key space —
    // see `sortScopeRows` for why those two sets differ.
    let min = this.minSortKey(this.sortScopeRows(repoId, repoPath, parentId))
    if (min !== null && min.length >= SORT_KEY_COMPACT_LEN) {
      this.compactSortKeys(this.sortKeySpaceRows(repoId, repoPath, parentId))
      min = this.minSortKey(this.sortScopeRows(repoId, repoPath, parentId))
    }
    return sortKeyBetween(null, min)
  }

  create(input: CreateIssueInput): IssueWire {
    if ((input as { stage?: string }).stage === 'shipping') {
      throw new Error('shipping stage is system-owned and requires a ship order')
    }
    // Same gate as `update` below, at the other door an issue can be homed
    // through (`podium issue create --machine`, the new-issue dialog):
    // POD-2700 §2.5 lists issue homing as an enforcement site, and refusing only
    // one of the two entry points is how a guard becomes decorative.
    if (input.machineId != null) this.store.d.requireIssueHomeMachine?.(input.machineId)
    // Allocate the #N off the stable repo_id so all checkouts of one origin share a
    // single sequence (#140) — resolve the path to its repo_id first, then allocate.
    const repoId = this.store.deps.store.repos.resolveRepoIdForPath(input.repoPath)
    const seq = this.store.deps.store.issues.nextIssueSeq(repoId)
    const ts = this.store.now()
    const settings = this.store.deps.getSettings()
    // THE shared answer to "which agent, model and effort?" (POD-1107) — the same
    // function the approvals broker's automation-schedule path calls, so the two
    // can no longer drift apart. The role-defaults rule [spec:SP-7ff1] lives
    // inside it now rather than being restated here.
    const spawnDefaults = resolveSpawnDefaults(settings, {
      agentKind: input.defaultAgent,
      model: input.defaultModel,
      effort: input.defaultEffort,
    })
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
      defaultAgent: spawnDefaults.agentKind,
      defaultModel: spawnDefaults.model,
      defaultEffort: spawnDefaults.effort,
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
      // Colour is a top-level property [spec:SP-b4d1]: a create that already
      // names a parent is a sub-issue, and it inherits the parent's colour
      // instead of holding one. Dropped rather than thrown — `create` takes a
      // shape, and refusing a whole subtask create over an inapplicable accent
      // would be a worse trade than ignoring the field.
      ...(input.color != null && input.parentId == null ? { color: input.color } : {}),
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
     *  can skip nudging the very session that caused them (self-nudge is noise).
     *  `cascadeArchive: false` keeps the close-sweep from also taking every
     *  living descendant — that walk is reserved for an explicit archive. */
    opts?: { actorSessionId?: SessionId; cascadeArchive?: boolean },
  ): IssueWire {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) throw new IssueNotFound(id)
    // `shipping` is lifecycle custody, not an ordinary board value. The
    // purpose-built Shipping service owns both directions; every existing
    // update/claim/start path converges here and is therefore unable to enter or
    // leave the stage accidentally.
    if (
      (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) ||
      patch.stage === 'shipping'
    ) {
      throw new Error('shipping stage is system-owned and cannot be changed by an issue update')
    }
    const prevStage = row.stage
    const wasClosed = this.store.isClosed(row)
    if (patch.stage === 'review' && row.stage !== 'review') {
      this.assertReviewArtifactOwnership(row)
    }
    // COLOUR IS A TOP-LEVEL PROPERTY [spec:SP-b4d1]. A sub-issue runs under its
    // parent's colour by inheritance (see `setParentForUpdate`), so setting one
    // on it is refused rather than silently dropped: the CLI and any older client
    // must hear that the field does not apply here, not appear to have written it.
    // Clearing (`color: null`) stays legal at any depth — it is how legacy slots
    // on existing sub-issues get cleaned up.
    if (patch.color != null) {
      const nextParentId = 'parentId' in patch ? patch.parentId : row.parentId
      if (nextParentId != null) {
        throw new Error(
          `colour belongs to top-level tasks: ${row.id} is a sub-task and takes its parent's colour`,
        )
      }
    }
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
    // HOMING AN ISSUE IS A MACHINE CHOICE (POD-2700 §2.5). The issue's machine
    // is where its worktree lives and where its agents run, so a machine that
    // runs no daemon can never be its home — refuse the property rather than
    // letting the pin sit there and dead-end every later action on it. Only when
    // the patch actually MOVES the pin: clearing it (`null`) and updates that do
    // not mention it are untouched.
    if (rowPatch.machineId != null && rowPatch.machineId !== row.machineId) {
      this.store.d.requireIssueHomeMachine?.(rowPatch.machineId)
    }
    if (
      rowPatch.worktreePath &&
      this.store.d.store.repos
        .listRepos(rowPatch.machineId ?? row.machineId ?? undefined)
        .some((repo) => sameWorktreePath(repo.path, rowPatch.worktreePath as string))
    ) {
      throw new Error(
        `refusing worktree path ${rowPatch.worktreePath}: a repository root cannot be recorded as an issue worktree`,
      )
    }

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
    // `update` is also an adoption seam for worktrees reported by a harness or
    // supplied by an operator. Only a patch that actually supplies a worktree can
    // establish placement; unrelated updates must not guess for historical NULL rows.
    if ('worktreePath' in rowPatch && row.worktreePath !== null && row.machineId === null) {
      row.machineId = this.store.resolveWorktreeMachine(undefined, row.worktreePath)
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
      void this.gitWorkflow()
        .refreshGitState(row.id)
        .catch(() => {})
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
    // A REORDER DELIBERATELY DOES NOT COMPACT (POD-1102), and the asymmetry is
    // the point: CREATE is the only thing that makes keys longer, so create is
    // the only thing that has to shorten them. A drag re-keys one row between
    // two neighbours and cannot move the scope's minimum at all.
    //
    // It was wired here first, so a repo that had stopped creating would still
    // repair itself the next time somebody dragged. Measured against this
    // workspace, that cost the DROP 2.5 seconds — a repair the operator waits
    // out mid-gesture, to fix a board whose drags already worked. The keys stay
    // long in such a repo until its next create, which is a storage wart nobody
    // can see, and the right trade against latency on the gesture itself.
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
      // Explicit archive dismisses the whole subtree so children do not
      // promote into the live list as orphans of a hidden parent.
      if (opts?.cascadeArchive !== false) this.archiveLivingDescendants(row.id)
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

  /** Review is the first point at which evidence is presented as durable truth.
   *  The bytes themselves are already safe — `panelArtifactAdd` snapshots them
   *  into the permanent store ([spec:SP-0fc9]), so evidence never has to be
   *  committed to the repo to survive. What review still requires is that each
   *  artifact PATH resolves inside the owning worktree, so the sidebar entry
   *  names a file on this issue rather than in some other checkout. Git tracking
   *  is deliberately NOT a gate (POD-1284): demanding it made agents commit
   *  screenshots and scratch docs the repo was never meant to carry. */
  private assertReviewArtifactOwnership(row: IssueRow): void {
    const artifacts = this.store.parsePanel(row).artifacts
    if (artifacts.length === 0) return
    if (!row.worktreePath) {
      throw new Error(
        `review blocked: issue ${row.seq} has artifacts but no owning worktree; restore the issue worktree and re-add the evidence`,
      )
    }
    const root = resolve(row.worktreePath)
    for (const artifact of artifacts) {
      const rel = relative(root, resolve(root, artifact.path))
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(
          `review blocked: artifact '${artifact.path}' is outside the owning issue worktree ${row.worktreePath}; re-add it from that worktree`,
        )
      }
    }
  }

  /** Mark this issue read (issue #124): stamp a covering read_at, persist + broadcast,
   *  and log issue.read. The stamp is max(now, this issue's updatedAt, descendant
   *  updatedAts, subtree lastActiveAt) so a session whose clock is a tick ahead of
   *  `now` cannot flip derived unread back on the same click (POD-912). PER-USER
   *  STATE (POD-1076): the marker is written to the actor's `(userId, issueId)`
   *  row, not to the issue. */
  markIssueRead(id: string): IssueWire {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) throw new IssueNotFound(id)
    this.store.writeIssueUserState(row.id, { readAt: this.coveringReadAt(row) })
    const wire = this.store.persist(row, { touch: false })
    this.store.emitEvent('issue.read', row.id, { seq: row.seq })
    return wire
  }

  /** The cursor that covers everything currently visible on this issue's row. */
  private coveringReadAt(row: IssueRow): string {
    const ids = new Set<string>([row.id])
    let grew = true
    while (grew) {
      grew = false
      for (const other of this.store.rows.values()) {
        if (other.parentId && ids.has(other.parentId) && !ids.has(other.id)) {
          ids.add(other.id)
          grew = true
        }
      }
    }
    let latest = this.store.now()
    for (const other of this.store.rows.values()) {
      if (!ids.has(other.id)) continue
      if (other.updatedAt > latest) latest = other.updatedAt
      for (const session of this.store.sessionsFor(other)) {
        if (session.lastActiveAt > latest) latest = session.lastActiveAt
      }
    }
    return latest
  }

  /** Mark this issue UNREAD again (issue #138, the email-style inverse of
   *  markIssueRead): clear the marker so the derived `unread` (readAt null ⇒ unread)
   *  flips back to true, persist + broadcast, and log issue.unread. Mirrors
   *  markIssueRead exactly, on the actor's own `(userId, issueId)` row (POD-1076);
   *  marking MY copy unread never touches yours. */
  markIssueUnread(id: string): IssueWire {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) throw new IssueNotFound(id)
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
    if (!row) throw new IssueNotFound(id)
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

  /** Permanently purge the automatically-created draft abandoned by an explicit
   *  session rehome. User-facing deletion must go through IssueSessionLifecycle
   *  and never reaches this method. */
  purgeEmptyDraft(ref: string): void {
    const id = this.store.resolveRef(ref)
    this.store.rowOrThrow(id)
    this.store.deps.ledger.commit({
      write: () => {
        // Explicit draft rehome detaches every session it can SEE before calling
        // this, but it sees them through `loadSessions()`
        // — `deleted_at IS NULL` — so a TOMBSTONED session keeps pointing at the
        // row we are about to delete, and `sessions.issue_id` has no foreign key
        // to catch it (POD-1926). Same transaction as the delete: a reference to
        // a half-deleted issue must never be observable.
        this.store.deps.store.sessions.detachTombstonesFromIssue(id)
        this.store.deps.store.issues.deleteIssue(id)
      },
      changes: () => [{ entity: 'issue', id, op: 'remove' }],
    })
    this.store.reload()
    // The full-list tail reconciles BOTH kinds (POD-796), so the purge reaches
    // the normalized feed as the remove reconcile derives from full truth.
    // POD-1203 deleted the funnel snapshot half; `reconcileAndPublish` is the
    // whole tail now.
    this.store.reconcileAndPublish(this.store.deps.publishSpecs.issuesChanged(this.store.allWire()))
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
      this.store.deps.store.issues.setIssueLabels(asIssueId(id), labels),
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
    if (!row) throw new IssueNotFound(id)
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

  /** Fill an empty coordinator seat from a real issue member. Automatic callers
   * use onlyMember so the first agent establishes the default without guessing
   * among an existing team; an explicit issue claim may name its bound caller.
   * Existing values — including intentional handoffs and dangling historical
   * ids — are never replaced here. */
  ensureCoordinator(id: string, sessionId: SessionId, opts?: { onlyMember?: boolean }): IssueWire {
    const row = this.store.rowOrThrow(this.store.resolveRef(id))
    if (row.coordinatorSessionId) return this.store.toWire(row)
    const eligible = this.store
      .sessionsFor(row)
      .filter(
        (session) =>
          session.agentKind !== 'shell' && !session.archived && session.status !== 'exited',
      )
    const candidate = eligible.find((session) => session.sessionId === sessionId)
    if (!candidate || (opts?.onlyMember && eligible.length !== 1)) {
      return this.store.toWire(row)
    }
    return this.update(row.id, { coordinatorSessionId: candidate.sessionId })
  }

  claim(id: string, assignee: UserId, opts?: { actorSessionId?: SessionId }): IssueWire {
    const claimed = this.update(id, { assignee, stage: 'in_progress' }, opts)
    return opts?.actorSessionId ? this.ensureCoordinator(claimed.id, opts.actorSessionId) : claimed
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
    //
    // CANONICALIZED ON WRITE (POD-1074): a caller that still says `wontfix`
    // stores `cancelled`, so the vocabulary stops growing new legacy rows. An
    // unrecognized reason is stored VERBATIM — the column is deliberately free
    // text and an integration with its own word for an ending should not have
    // it silently rewritten to "done".
    const canonical = canonicalIssueCloseReason(reason) ?? reason
    return this.update(id, { stage: 'done', closedReason: canonical }, opts)
  }

  applySuggestion(id: string): IssueWire {
    const row = this.store.rowOrThrow(id)
    if (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) {
      throw new Error('shipping stage is system-owned and cannot apply an issue suggestion')
    }
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
    if (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) {
      throw new Error('shipping stage is system-owned and cannot dismiss an issue suggestion')
    }
    row.suggestedStage = null
    row.suggestedReason = null
    return this.store.persistRow(row)
  }
}
