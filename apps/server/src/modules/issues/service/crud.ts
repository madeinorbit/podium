import { randomBytes, randomUUID } from 'node:crypto'
import {
  type ArtifactId,
  type ArtifactUploadPacket,
  type Attribution,
  asArtifactId,
  asIssueId,
  asRepoId,
  asSessionId,
  asUserId,
  canonicalIssueCloseReason,
  firstAdminMemberId,
  type GrantVerb,
  type IssueId,
  type IssueProjection,
  isAbsoluteMachinePath,
  isIssueStage,
  isSortKey,
  isSystemOwnedIssueStage,
  issueUserStateRowId,
  type MachineId,
  machinePathBasename,
  machinePathRelativeToRoot,
  machinePathSegments,
  normalizeClosedPatch,
  type RepoId,
  type SessionId,
  SORT_KEY_COMPACT_LEN,
  SORT_KEY_MAX_LEN,
  sortKeyBetween,
  spreadSortKeys,
  type UserId,
} from '@podium/model'
import { resolveSpawnDefaults } from '@podium/runtime'
import type { EntityChangeSpec } from '@podium/sync'
import type { IssueRow } from '../../../store'
import { afterCommit, followUpAfterCommit } from '../../../store/executor/executor'
import { type StoredIssue, toStorage } from '../../../store/issue-storage'
import type { IssueTextField, IssueTextRevisionRow } from '../../../store/types'
import { readIssue } from '../issue-reader'
import { type IssueStore, worktreeOf } from './core'
import { IssueNotFound } from './not-found'
import { defaultParentBranchFor } from './parent-branch'
import { IssueRefusal } from './refusal'
import type { CreateIssueInput, IssueDeps, IssuePanelOp, IssuePatch } from './types'
import { UNSNOOZE_BACKDATE_MS } from './types'
import { sameWorktreePath } from './worktree-safety'

/**
 * Board-organization fields only — pin / drag-reorder. These must not bump
 * `updatedAt` (and therefore must not re-flip derived `unread` via
 * `computeUnread`: lastActivity > readAt). Whitelist: any new IssuePatch field
 * defaults to content/activity behavior so accidental omission stays safe.
 */
/** The task texts that keep a revision history (POD-6289). */
const ISSUE_TEXT_FIELDS = ['description', 'brief'] as const satisfies readonly IssueTextField[]

/** A row's description and brief, absent spelled `''` so a compare sees text. */
function issueTexts(row: IssueRow): Record<IssueTextField, string> {
  return { description: row.description ?? '', brief: row.brief ?? '' }
}

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

/** Terminal proof may leave the issue worktree, but only as a declared visual
 * capture. Raw scrollback is text and must stay out of this escape hatch. */
const TERMINAL_EVIDENCE_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
])

const terminalEvidenceHelp = (seq: number): string =>
  `For a terminal screenshot, run from the issue session checkout with ` +
  `\`podium issue artifact ${seq} --add <relative-image> --terminal-evidence\`; ` +
  `only raster images are accepted. Attach redacted terminal text with an ordinary CLI upload ` +
  `or --content "…" --name report.md; neither requires an issue worktree.`

function isTerminalEvidenceImage(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return TERMINAL_EVIDENCE_IMAGE_EXTENSIONS.has(extension)
}

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
  wire(): IssueProjection
  write(): Promise<void>
  changes(): EntityChangeSpec[]
  /** External effects after the commit. Durable work belongs in {@link write},
   *  where it rolls back with the row; since POD-6158 there is no in-memory
   *  copy of the issue to install. */
  publish(): Promise<void>
}

/** Internal custody mutation used only by the shipping control plane. The
 * normalized repository write and its compact shipOrder row ride the same
 * outer Ledger transaction as any issue stage/attention change. */
export interface ShippingIssueMutation {
  expectedStage: 'review' | 'shipping' | 'done' | readonly ('review' | 'shipping' | 'done')[]
  nextStage?: 'shipping' | 'review' | 'done'
  nextStageForResult?: (result: unknown) => 'shipping' | 'review' | 'done' | undefined
  needsHuman?: boolean
  shipOrderChanges:
    | readonly EntityChangeSpec[]
    | ((result: unknown) => readonly EntityChangeSpec[] | Promise<readonly EntityChangeSpec[]>)
  event?:
    | { kind: string; payload: Record<string, unknown> }
    | ((
        result: unknown,
      ) =>
        | { kind: string; payload: Record<string, unknown> }
        | undefined
        | Promise<{ kind: string; payload: Record<string, unknown> } | undefined>)
}

/**
 * CRUD and stage-machine capability:
 * create/update and every close/reopen path, dependency + hierarchy edits,
 * labels/comments/panel/state, and the attention-state event emissions that
 * update() detects. Every mutation ends in persist()/broadcastList() (core).
 */
/** The columns a manual-order key space is ordered and measured by. */
interface SortScopeRow {
  id: IssueId
  sortKey: string | null
  createdAt: string
  seq: number
}

interface IssueCrudHierarchyPort {
  reparent(id: string, parentId: string | null): Promise<IssueProjection>
  setParentForUpdate(row: IssueRow, parentId: import('@podium/model').IssueId | null): Promise<void>
}

interface IssueCrudAttentionPort {
  onIssueArchived(row: IssueRow, archivedBy?: UserId): void | Promise<void>
  retireIssueOffers(row: IssueRow): void | Promise<void>
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
    private readonly onIssueClosed?: IssueDeps['onIssueClosed'],
  ) {}

  async shippingCommit<T>(
    id: IssueId,
    mutation: ShippingIssueMutation,
    write: () => T | Promise<T>,
  ): Promise<{ issue: IssueProjection; result: T }> {
    const row = await this.store.draftOrThrow(await this.store.resolveRef(id))
    const expectedStages = Array.isArray(mutation.expectedStage)
      ? mutation.expectedStage
      : [mutation.expectedStage]
    const needsHumanBefore = row.needsHuman
    let result: T | undefined
    const issue = await this.store.persistWith(
      row,
      async () => {
        if (!(expectedStages as readonly string[]).includes(row.stage)) {
          throw new IssueRefusal(
            `issue ${row.id} shipping stage fence failed: expected ${expectedStages.join(' or ')}`,
          )
        }
        result = await write()
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
          row.humanQuestionAttribution = null
        }
      },
      {
        extraChanges: async () =>
          typeof mutation.shipOrderChanges === 'function'
            ? await mutation.shipOrderChanges(result as T)
            : mutation.shipOrderChanges,
      },
    )
    const event =
      typeof mutation.event === 'function' ? await mutation.event(result as T) : mutation.event
    if (event) await this.store.emitEvent(event.kind, row.id, event.payload)
    if (!needsHumanBefore && mutation.needsHuman === true) {
      await this.store.emitEvent('issue.needs_human', row.id, { seq: row.seq, kind: 'ship-hold' })
    } else if (needsHumanBefore && mutation.needsHuman === false) {
      await this.store.emitEvent('issue.needs_human_cleared', row.id, {
        seq: row.seq,
        kind: 'ship-hold',
      })
    }
    return { issue, result: result as T }
  }

  async shippingCommitMany<T>(
    entries: readonly { id: IssueId; mutation: ShippingIssueMutation }[],
    write: () => T | Promise<T>,
  ): Promise<{ issues: IssueProjection[]; result: T }> {
    if (entries.length === 0) throw new Error('shipping batch requires an affected issue')
    const rows = await Promise.all(
      entries.map(async ({ id }) => await this.store.draftOrThrow(await this.store.resolveRef(id))),
    )
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
        throw new IssueRefusal(
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
      row.humanQuestionAttribution = null
    }
    const committed = await this.store.persistManyWith(
      rows,
      write,
      async (result) => {
        const groups = await Promise.all(
          entries.map(async ({ mutation }) =>
            typeof mutation.shipOrderChanges === 'function'
              ? await mutation.shipOrderChanges(result)
              : mutation.shipOrderChanges,
          ),
        )
        const changes = groups.flat()
        return [
          ...new Map(changes.map((change) => [`${change.entity}:${change.id}`, change])).values(),
        ]
      },
      async (result) =>
        (
          await Promise.all(
            entries.map(async ({ mutation }, index) => {
              const row = rows[index]!
              const event =
                typeof mutation.event === 'function' ? await mutation.event(result) : mutation.event
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
        ).flat(),
    )
    return committed
  }

  /** Agent-posted "where things stand" — writes activityNotes directly (the same
   *  field the assistant digest maintains; an explicit agent post is fresher truth
   *  and simply overwrites, and vice versa). Shown in the issue sidebar header. */
  async setState(id: string, text: string): Promise<IssueProjection> {
    const row = await this.store.draftOrThrow(id)
    row.activityNotes = text
    row.notesUpdatedAt = this.store.now()
    const wire = await this.store.persist(row)
    await this.store.emitEvent('issue.state', row.id, { seq: row.seq })
    return wire
  }

  /** Apply one mutation to an issue's agent-published human panel (right-sidebar
   *  "Issue" tab): human-facing todos, artifacts (files the user should look at),
   *  and deferred-work items awaiting a user decision. Indexes are 1-based (what
   *  the CLI prints). Persists + broadcasts like any other issue update. */
  async panelApply(id: string, op: IssuePanelOp): Promise<IssueProjection> {
    const row = await this.store.draftOrThrow(id)
    const panel = this.store.parsePanel(row)
    const at = <T>(list: T[], index: number): T => {
      const item = list[index - 1]
      if (!item) throw new IssueRefusal(`no item ${index} (list has ${list.length})`)
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
          ...(op.sourceKind ? { sourceKind: op.sourceKind } : {}),
          ...(op.chatUploadId ? { chatUploadId: op.chatUploadId } : {}),
          ...(op.chatUploadOwner ? { chatUploadOwner: op.chatUploadOwner } : {}),
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
    const wire = await this.store.persist(row)
    await this.store.emitEvent('issue.panel', row.id, { seq: row.seq, op: op.op })
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
    input: {
      path: string
      title?: string
      extraPaths?: string[]
      terminalEvidence?: boolean
      sourceRoot?: string
    },
    opts?: { actorSessionId?: SessionId },
  ): Promise<IssueProjection> {
    const row = await this.store.rowOrThrow(await this.store.resolveRef(id))
    const store = this.store.deps.artifacts
    const terminalEvidence = input.terminalEvidence === true
    const session = opts?.actorSessionId
      ? await this.store.deps.sessionById(opts.actorSessionId)
      : undefined

    if (input.sourceRoot && !terminalEvidence) {
      throw new IssueRefusal(
        `sourceRoot is only valid with --terminal-evidence. ${terminalEvidenceHelp(row.seq)}`,
      )
    }
    if (terminalEvidence) {
      if (!store) {
        throw new Error(
          `terminal evidence needs the permanent artifact store. ${terminalEvidenceHelp(row.seq)}`,
        )
      }
      if (!session || session.issueId !== row.id) {
        throw new IssueRefusal(
          `terminal evidence may only be captured by a session belonging to issue ${row.seq}. ` +
            terminalEvidenceHelp(row.seq),
        )
      }
      if (!input.sourceRoot || !isAbsoluteMachinePath(input.sourceRoot)) {
        throw new IssueRefusal(
          `terminal evidence needs the checkout where the command is running; ` +
            `rerun from that checkout with --terminal-evidence. ${terminalEvidenceHelp(row.seq)}`,
        )
      }
      if (row.machineId && session.machineId && row.machineId !== session.machineId) {
        throw new IssueRefusal(
          `terminal evidence must come from the same machine as the issue session. ` +
            terminalEvidenceHelp(row.seq),
        )
      }
    }

    // Ordinary evidence belongs to the ISSUE worktree, never whichever checkout
    // happened to invoke the command. The explicit terminal-evidence path is the
    // narrow exception: it is bound to the calling session and its current root.
    const root = terminalEvidence ? input.sourceRoot : row.worktreePath
    if (!root) {
      throw new IssueRefusal(
        `issue ${row.seq} has no owning worktree for a daemon file read; use the CLI's local upload ` +
          `or --content "…" --name report.md to attach without a worktree. ` +
          terminalEvidenceHelp(row.seq),
      )
    }
    const normalizeSource = (sourcePath: string): string => {
      if (terminalEvidence && isAbsoluteMachinePath(sourcePath, root)) {
        throw new IssueRefusal(
          `terminal evidence path '${sourcePath}' must be relative to the checkout where ` +
            `the command runs. ${terminalEvidenceHelp(row.seq)}`,
        )
      }
      const rel = machinePathRelativeToRoot(root, sourcePath)
      if (!rel) {
        throw new IssueRefusal(
          terminalEvidence
            ? `terminal evidence path '${sourcePath}' is outside the command checkout ${root}. ${terminalEvidenceHelp(row.seq)}`
            : `artifact path '${sourcePath}' is outside the owning issue worktree ${root}. ${terminalEvidenceHelp(row.seq)}`,
        )
      }
      return machinePathSegments(rel, root).join('/')
    }
    const sourcePath = normalizeSource(input.path)
    const extraPaths = input.extraPaths?.map(normalizeSource)
    if (terminalEvidence && ![sourcePath, ...(extraPaths ?? [])].every(isTerminalEvidenceImage)) {
      throw new IssueRefusal(
        `terminal evidence accepts raster image files only; raw terminal text and scrollback ` +
          `are refused. ${terminalEvidenceHelp(row.seq)}`,
      )
    }
    // Re-add keeps the existing title unless a new one is given.
    const existing = this.store.parsePanel(row).artifacts.find((a) => a.path === sourcePath)
    const effectiveTitle = input.title ?? existing?.title
    const title = effectiveTitle ? { title: effectiveTitle } : {}
    if (!store) {
      return await this.panelApply(row.id, {
        op: 'artifact-add',
        path: sourcePath,
        ...title,
        sourcePaths: [sourcePath, ...(extraPaths ?? [])],
        ...(terminalEvidence ? { sourceKind: 'terminal-evidence' as const } : {}),
      })
    }
    // Owning machine is the issue's machine; the invoking session is only a
    // fallback for old rows that predate a machine pin. Terminal evidence has
    // already proved that the two refer to the same issue/session boundary.
    const machineId = row.machineId ?? session?.machineId ?? undefined
    const snap = await store.snapshot({
      issueId: row.id,
      root,
      ...(machineId ? { machineId } : {}),
      sourcePath,
      ...(extraPaths?.length ? { extraPaths } : {}),
    })
    if (terminalEvidence && !snap.files.every((file) => isTerminalEvidenceImage(file.path))) {
      await store.remove(row.id, snap.artifactId).catch(() => {})
      throw new IssueRefusal(
        `terminal evidence accepts raster image files only; raw terminal text and scrollback ` +
          `are refused. ${terminalEvidenceHelp(row.seq)}`,
      )
    }
    const sourcePaths = [...new Set(snap.sourcePaths ?? [sourcePath, ...(extraPaths ?? [])])]
    const oldId = existing?.artifactId
    const wire = await this.panelApply(row.id, {
      op: 'artifact-add',
      path: sourcePath,
      ...title,
      artifactId: snap.artifactId,
      entry: snap.entry,
      files: snap.files,
      sourcePaths,
      ...(terminalEvidence ? { sourceKind: 'terminal-evidence' as const } : {}),
    })
    if (oldId) void store.remove(row.id, oldId).catch(() => {})
    return wire
  }

  /** Upload packets are issue-scoped by the command registry. Only a complete
   * snapshot is published; replacement keeps the logical path and list position. */
  async panelArtifactTransfer(id: string, packet: ArtifactUploadPacket): Promise<IssueProjection> {
    const row = await this.store.rowOrThrow(await this.store.resolveRef(id))
    const artifacts = this.store.deps.artifacts
    if (!artifacts?.transfer)
      throw new IssueRefusal('direct artifact uploads are unavailable on this server')
    const result = await artifacts.transfer(row.id, packet)
    if (!result) return await this.store.projection(await this.store.rowOrThrow(row.id))
    const { snapshot, path } = result
    try {
      // The issue may have changed or been deleted while bytes were arriving.
      const current = await this.store.rowOrThrow(row.id)
      const existing = this.store
        .parsePanel(current)
        .artifacts.find((artifact) => artifact.path === path)
      const title = result.title ?? existing?.title
      const wire = await this.panelApply(row.id, {
        op: 'artifact-add',
        path,
        ...(title !== undefined ? { title } : {}),
        artifactId: snapshot.artifactId,
        entry: snapshot.entry,
        files: snapshot.files,
      })
      if (existing?.artifactId) void artifacts.remove(row.id, existing.artifactId).catch(() => {})
      return wire
    } catch (error) {
      await artifacts.remove(row.id, snapshot.artifactId).catch(() => {})
      throw error
    }
  }

  /** Attach browser-provided bytes straight to the issue's permanent artifact
   *  store. Unlike `panelArtifactAdd`, this has no source path and therefore no
   *  issue-worktree requirement. */
  async panelArtifactUpload(
    id: string,
    input: { id: string; filename: string; dataBase64: string },
  ): Promise<IssueProjection> {
    const row = await this.store.rowOrThrow(await this.store.resolveRef(id))
    const store = this.store.deps.artifacts
    if (!store) throw new Error('permanent issue artifact storage is unavailable')
    if (!/^[A-Za-z0-9._-]+$/.test(input.id)) throw new IssueRefusal('invalid draft artifact id')
    const snap = await store.upload({
      issueId: row.id,
      filename: input.filename,
      dataBase64: input.dataBase64,
    })
    const path = `attachments/${input.id}/${snap.entry}`
    const existing = this.store.parsePanel(row).artifacts.find((artifact) => artifact.path === path)
    try {
      const wire = await this.panelApply(row.id, {
        op: 'artifact-add',
        path,
        title: input.filename,
        artifactId: snap.artifactId,
        entry: snap.entry,
        files: snap.files,
        sourceKind: 'creation-attachment',
      })
      if (existing?.artifactId) void store.remove(row.id, existing.artifactId).catch(() => {})
      return wire
    } catch (error) {
      void store.remove(row.id, snap.artifactId).catch(() => {})
      throw error
    }
  }

  /**
   * CLAIM A COMPOSER UPLOAD INTO THIS ISSUE (POD-2148): the message that
   * carries it was sent, or the task it was picked for was created. Only the
   * person who uploaded it may claim it, and only into one issue; claiming it
   * again into the same issue is the claim already made (a replayed send).
   *
   * The bytes move by rename (no re-read) under the server-transfer write
   * fence, so a fenced store refuses the claim rather than losing the file.
   * The panel entry carries the upload id: it is what the chat finds the
   * thumbnail by, and what delivery stages the file from.
   */
  async panelChatUploadClaim(
    issueId: IssueId,
    input: { uploadId: string; ownerUserId: UserId },
  ): Promise<void> {
    // The uploader is checked before either shortcut (a claim already made, or
    // one in flight), so a reader of a shared issue cannot reuse an id it sees.
    await this.assertChatUploadOwner(issueId, input)
    const key = `${issueId}\0${input.uploadId}`
    const running = this.chatUploadClaims.get(key)
    if (running) return await running
    const claim = this.underChatUploadLock(key, () => this.claimChatUpload(issueId, input)).finally(
      () => {
        this.chatUploadClaims.delete(key)
      },
    )
    this.chatUploadClaims.set(key, claim)
    return await claim
  }

  /** Claim, release and the delivery read of one upload on one issue run one
   *  at a time, so none sees another's half-moved file. */
  private readonly chatUploadLocks = new Map<string, Promise<void>>()

  private async underChatUploadLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chatUploadLocks.get(key) ?? Promise.resolve()
    const current = previous.then(run)
    const tail = current.then(
      () => {},
      () => {},
    )
    this.chatUploadLocks.set(key, tail)
    try {
      return await current
    } finally {
      if (this.chatUploadLocks.get(key) === tail) this.chatUploadLocks.delete(key)
    }
  }

  /** In-flight claims by issue + upload id: two overlapping sends of one
   *  upload share a single move. */
  private readonly chatUploadClaims = new Map<string, Promise<void>>()

  private async assertChatUploadOwner(
    issueId: IssueId,
    input: { uploadId: string; ownerUserId: UserId },
  ): Promise<void> {
    const row = await this.store.rowOrThrow(issueId)
    const entry = this.store
      .parsePanel(row)
      .artifacts.find((a) => a.chatUploadId === input.uploadId)
    const owner = entry
      ? entry.chatUploadOwner
      : (await this.store.deps.pendingUploads?.meta(input.uploadId))?.ownerUserId
    if (owner !== input.ownerUserId) {
      throw new IssueRefusal('this attachment is no longer available; attach the file again')
    }
  }

  /**
   * Undo a discarded draft's claims before its purge deletes its artifacts
   * (POD-2148): each chat upload's file moves back to pending and forgets the
   * claim, so retrying the same create claims it again. Claims are found from
   * the panel AND from the pending metas naming this issue, so one whose panel
   * commit never landed is returned too. Answers whether every one came back;
   * when not, the caller keeps the artifact dir, which may hold its only copy.
   * Only for a draft whose launch failed with no session on it.
   */
  async panelChatUploadRelease(issueId: IssueId): Promise<boolean> {
    const pending = this.store.deps.pendingUploads
    const store = this.store.deps.artifacts
    if (!pending || !store?.relinquish) return true
    const row = await this.store.rowOrThrow(issueId).catch(() => undefined)
    const uploadIds = new Set([
      ...(row
        ? this.store
            .parsePanel(row)
            .artifacts.flatMap((a) => (a.chatUploadId ? [a.chatUploadId] : []))
        : []),
      ...(await pending.claimedBy(issueId)).map((meta) => meta.id),
    ])
    let returned = true
    for (const uploadId of uploadIds) {
      try {
        await this.underChatUploadLock(`${issueId}\0${uploadId}`, async () => {
          const meta = await pending.meta(uploadId)
          if (meta?.claimed?.issueId !== issueId) return
          await store.relinquish?.({
            issueId,
            artifactId: meta.claimed.artifactId,
            toDir: pending.fileDir(uploadId),
          })
          await pending.markUnclaimed(uploadId)
        })
      } catch {
        returned = false
      }
    }
    return returned
  }

  private async claimChatUpload(
    issueId: IssueId,
    input: { uploadId: string; ownerUserId: UserId },
  ): Promise<void> {
    const row = await this.store.rowOrThrow(issueId)
    const pending = this.store.deps.pendingUploads
    const store = this.store.deps.artifacts
    const meta = await pending?.meta(input.uploadId)
    // Claimed already — unless a failed launch handed the file back since.
    const entry = this.store
      .parsePanel(row)
      .artifacts.some((a) => a.chatUploadId === input.uploadId)
    if (entry && (!meta || meta.claimed?.issueId === issueId)) return
    if (!pending || !store?.adopt)
      throw new IssueRefusal('chat uploads are not stored on this server')
    if (!meta || meta.ownerUserId !== input.ownerUserId) {
      throw new IssueRefusal('this attachment is no longer available; attach the file again')
    }
    if (meta.claimed && meta.claimed.issueId !== issueId) {
      throw new IssueRefusal(
        'this attachment was already sent with another task; attach the file again',
      )
    }
    const claimed = meta.claimed ?? {
      issueId,
      artifactId: asArtifactId(randomBytes(6).toString('hex')),
    }
    if (!meta.claimed) await pending.markClaimed(input.uploadId, claimed)
    const snap = await store.adopt({
      issueId,
      artifactId: claimed.artifactId,
      fromDir: pending.fileDir(input.uploadId),
      entry: meta.entry,
    })
    try {
      await this.panelApply(issueId, {
        op: 'artifact-add',
        path: `chat-uploads/${input.uploadId}/${snap.entry}`,
        title: meta.filename,
        artifactId: snap.artifactId,
        entry: snap.entry,
        files: snap.files,
        chatUploadId: input.uploadId,
        chatUploadOwner: input.ownerUserId,
      })
    } catch (error) {
      // No entry names the moved file: put it back in pending and forget the
      // claim (still under this upload's lock), so the same ref can be claimed
      // again. If that fails too, the meta still names this issue, and a draft
      // discard finds it there and keeps the dir rather than purge it.
      try {
        await store.relinquish?.({
          issueId,
          artifactId: snap.artifactId,
          toDir: pending.fileDir(input.uploadId),
        })
        await pending.markUnclaimed(input.uploadId)
      } catch {}
      throw error
    }
  }

  /** Who uploaded the chat upload this issue holds under this id (POD-2148):
   *  undefined when it holds none, null when the entry names nobody. Only the
   *  uploader may hand it to an agent. */
  async chatUploadOwner(issueId: IssueId, uploadId: string): Promise<UserId | null | undefined> {
    const row = await this.store.rowOrThrow(issueId).catch(() => undefined)
    if (!row) return undefined
    const entry = this.store.parsePanel(row).artifacts.find((a) => a.chatUploadId === uploadId)
    if (!entry) return undefined
    return entry.chatUploadOwner ? (entry.chatUploadOwner as UserId) : null
  }

  /** A claimed chat upload's bytes, for staging on the agent's machine at
   *  delivery (POD-2148). Undefined when the issue no longer holds them. */
  async chatUploadBytes(issueId: IssueId, uploadId: string): Promise<Uint8Array | undefined> {
    // Never mid-move: wait out a claim or release of this upload.
    await this.chatUploadLocks.get(`${issueId}\0${uploadId}`)
    const row = await this.store.rowOrThrow(issueId).catch(() => undefined)
    const store = this.store.deps.artifacts
    if (!row || !store) return undefined
    const entry = this.store
      .parsePanel(row)
      .artifacts.find((a) => a.chatUploadId === uploadId && a.artifactId)
    if (!entry?.artifactId) return undefined
    const found = await store.read(
      issueId,
      entry.artifactId,
      entry.entry ?? machinePathBasename(entry.path) ?? '',
    )
    return found ? new Uint8Array(found.bytes) : undefined
  }

  /** artifact-remove that also deletes the snapshot's store dir ([spec:SP-0fc9]).
   *  The dir delete is best-effort AFTER the committed panel update. */
  async panelArtifactRemove(id: string, index: number): Promise<IssueProjection> {
    const row = await this.store.rowOrThrow(await this.store.resolveRef(id))
    const removed = this.store.parsePanel(row).artifacts[index - 1]
    const wire = await this.panelApply(row.id, { op: 'artifact-remove', index })
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
    const row = await this.store.rowOrThrow(await this.store.resolveRef(id))
    const artifacts = this.store.parsePanel(row).artifacts
    if (artifacts.length === 0) throw new IssueRefusal('this issue has no artifacts')
    const at =
      input.index != null
        ? input.index - 1
        : input.path != null
          ? artifacts.findIndex((a) => a.path === input.path)
          : -1
    if (input.index == null && input.path == null) {
      throw new IssueRefusal('name the artifact to read: an index or a path')
    }
    const entryRow = at >= 0 ? artifacts[at] : undefined
    if (!entryRow) {
      throw new IssueRefusal(
        input.path != null
          ? `no artifact with path ${input.path} (issue has ${artifacts.length})`
          : `no artifact ${input.index} (issue has ${artifacts.length})`,
      )
    }
    const store = this.store.deps.artifacts
    // A pre-snapshot entry (or a deployment with no store wired) has a path and
    // nothing behind it — say so rather than 404ing as if the file were missing.
    if (!store || !entryRow.artifactId) {
      throw new IssueRefusal(
        `artifact ${at + 1} (${entryRow.path}) has no stored snapshot — re-add it ` +
          'with `podium issue artifact <id> --add <path>` to capture its content',
      )
    }
    const file = input.file ?? entryRow.entry ?? machinePathBasename(entryRow.path) ?? entryRow.path
    const found = await store.read(row.id, entryRow.artifactId, file)
    if (!found) {
      const known = (entryRow.files ?? []).map((f) => f.path).join(', ')
      throw new IssueRefusal(
        `artifact ${at + 1} has no stored file ${file}${known ? ` (bundle holds: ${known})` : ''}`,
      )
    }
    if (found.bytes.length > ARTIFACT_READ_CAP_BYTES) {
      throw new IssueRefusal(
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
   *  was `closed`): open rows in the same repo with a `blocked-by` dep on it whose wire
   *  `ready` is now true.
   *
   *  The ready rows are one DURABLE FOLLOW-UP, not independent best-effort
   *  appends. Every read completes before the event transaction begins, and all
   *  events append in one transaction, so the durable fanout is all-or-nothing.
   *  A failure is reported as a committed post-commit failure: the close stays
   *  committed, while the caller is told that its ready fanout did not land. */
  private async emitReadyAfterClose(
    closed: IssueRow,
    actorSessionId?: SessionId,
    causedByUserId?: UserId,
  ): Promise<void> {
    await followUpAfterCommit(async () => {
      const inScope = await this.store.repoScopeFilter(closed.repoPath)
      const ready: IssueRow[] = []
      const dependents = await this.store.deps.store.issues.listDependents(closed.id)
      // The blocked dependents and their readiness, each read once for the set.
      const rows = await this.store.rowsByIds(
        dependents.filter((dep) => dep.type === 'blocked-by').map((dep) => dep.fromId),
      )
      const readyIds = await this.store.readyAmong([...rows.values()].filter((row) => inScope(row)))
      for (const dep of dependents) {
        if (dep.type !== 'blocked-by') continue
        const row = rows.get(dep.fromId)
        if (row && readyIds.has(row.id)) ready.push(row)
      }
      if (ready.length === 0) return

      await this.store.deps.store.transact(async () => {
        for (const r of ready) {
          await this.store.deps.store.events.appendEvent({
            ts: this.store.now(),
            kind: 'issue.ready',
            subject: r.id,
            repoPath: r.repoPath,
            payload: {
              seq: r.seq,
              unblockedBy: closed.seq,
              ...(actorSessionId ? { causedBySessionId: actorSessionId } : {}),
              ...(causedByUserId ? { causedByUserId } : {}),
            },
          })
        }
      })
    }, 'issue-ready-after-close')
  }

  /** Closing a parent retires its descendant progress record and stopped
   *  sessions [spec:SP-6144]. The cascade archives ONLY children that are
   *  themselves closed, already read, and have no live member session — open
   *  work, unread results, and running agents are skipped (and surfaced via a
   *  single issue.cascade_skipped event on the parent) instead of vanishing
   *  from the live views out from under the operator. */
  private async archiveClosedSubtree(parentId: string, caller?: UserId): Promise<void> {
    const skipped: Array<{ seq: number; why: string }> = []
    const children = await this.store.childRows(parentId, { live: true, unarchived: true })
    // Each child's own ASSIGNEE's markers (POD-6291): the person accountable for
    // that child is the one whose "seen it" lets a parent close sweep it.
    const markers = await this.store.issueUserStates(children.map((child) => child.id))
    for (const child of children) {
      if (!this.store.isClosed(child)) continue // open work is never swept by a parent close
      // Per-user read state (POD-1076): "the operator has seen it" is now the
      // assignee's read, never the first admin's.
      if ((markers.get(child.id)?.readAt ?? null) == null) {
        skipped.push({ seq: child.seq, why: 'unread' })
        continue
      }
      // The sessions attached to this child, from the database (POD-6160): with
      // no worktree path, membership is exactly `issueId === child.id`.
      const live = (await this.store.deps.readSessionFactsByIssue(null, child.id)).some(
        (s) => s.issueId === child.id && !s.archived && s.status !== 'exited',
      )
      if (live) {
        skipped.push({ seq: child.seq, why: 'live session' })
        continue
      }
      await this.archiveClosedSubtree(child.id, caller)
      // Close-sweep must not take the explicit-archive descendant walk: an
      // open grandchild of a qualifying child has to stay live. The operator
      // archive path below is the one that dismisses the whole subtree.
      await this.update(
        child.id,
        { archived: true },
        { cascadeArchive: false, ...(caller ? { caller } : {}) },
      )
    }
    if (skipped.length) {
      const parent = await this.store.row(parentId)
      if (parent) {
        await this.store.emitEvent('issue.cascade_skipped', parentId, { seq: parent.seq, skipped })
      }
    }
  }

  /** Explicit archive of a parent dismisses every living descendant. Unlike
   *  {@link archiveClosedSubtree}, open / unread / live-session children are
   *  not spared: the operator hid the container, and leaving those children
   *  independently visible is how they resurface as "new" work. Recurses
   *  through each child's own `update({ archived: true })` so session teardown
   *  and events stay on the same path as a direct archive. */
  private async archiveLivingDescendants(parentId: string, caller?: UserId): Promise<void> {
    for (const child of await this.store.childRows(parentId, { live: true, unarchived: true })) {
      await this.update(child.id, { archived: true }, caller ? { caller } : undefined)
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
  private async sortScopeRows(
    repoId: RepoId | null | undefined,
    repoPath: string,
    parentId: string | null,
    opts: { includePinned: true } | { unpinnedFor: UserId },
  ): Promise<SortScopeRow[]> {
    // One narrow read of the key space (POD-6192): every stored issue has a
    // repository id, so the top level is the repository's issues without a
    // parent; the viewer's pins are left out in SQL.
    const issues = this.store.deps.store.issues
    const rows = parentId
      ? await issues.sortScope({ parentId: asIssueId(parentId) })
      : repoId
        ? await issues.sortScope({
            repoId,
            ...('unpinnedFor' in opts ? { unpinnedFor: opts.unpinnedFor } : {}),
          })
        : []
    return rows
  }

  /** The rows a compaction of this scope must renumber — the whole key space,
   *  pinned rows included. See {@link sortScopeRows}. */
  private async sortKeySpaceRows(
    repoId: RepoId | null | undefined,
    repoPath: string,
    parentId: string | null,
  ): Promise<SortScopeRow[]> {
    return await this.sortScopeRows(repoId, repoPath, parentId, { includePinned: true })
  }

  /** The scope's current top key, corrupt/legacy keys ignored. */
  private minSortKey(scope: readonly SortScopeRow[]): string | null {
    let min: string | null = null
    for (const r of scope) {
      const k = r.sortKey
      if (isSortKey(k) && (min === null || k < min)) min = k
    }
    return min
  }

  private orderedSortRows<T extends SortScopeRow>(scope: readonly T[]): T[] {
    return [...scope].sort((a, b) => {
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
  }

  /** Resolve a sibling-relative position server-side, without making callers mint keys. */
  async move(id: string, placement: { before?: string; after?: string }): Promise<IssueProjection> {
    if ((placement.before !== undefined) === (placement.after !== undefined)) {
      throw new IssueRefusal('pass exactly one of --before or --after')
    }
    // Serialize neighbor reads with the write, including any key-space repair.
    return await this.store.deps.store.transact(async () => {
      const row = await this.store.rowOrThrow(await this.store.resolveRef(id))
      const reference = (placement.before ?? placement.after)!
      const anchor = await this.store.rowOrThrow(
        await this.store.resolveRef(reference, row.repoPath),
      )
      if (row.deletedAt || anchor.deletedAt) {
        throw new IssueRefusal('deleted issues cannot be moved or used as move references')
      }
      if (row.id === anchor.id)
        throw new IssueRefusal('an issue cannot be moved relative to itself')
      if (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) {
        throw new IssueRefusal(
          'shipping stage is system-owned and cannot be changed by an issue move',
        )
      }
      const keySpace = async () =>
        await this.sortKeySpaceRows(row.repoId, row.repoPath, row.parentId ?? null)
      let scope = await keySpace()
      if (!scope.some((sibling) => sibling.id === anchor.id)) {
        throw new IssueRefusal('move requires siblings with the same parent and repository')
      }
      let siblings = this.orderedSortRows(scope).filter((sibling) => sibling.id !== row.id)
      // Old rows may lack keys, and reparenting can bring equal keys into one space.
      // Repair only when a strict midpoint cannot represent the existing order.
      const seen = new Set<string>()
      if (
        siblings.some((sibling) => {
          const key = sibling.sortKey
          if (!isSortKey(key) || seen.has(key) || key.length >= SORT_KEY_MAX_LEN) return true
          seen.add(key)
          return false
        })
      ) {
        await this.compactSortKeys(scope)
        scope = await keySpace()
        siblings = this.orderedSortRows(scope).filter((sibling) => sibling.id !== row.id)
      }
      const anchorIndex = siblings.findIndex((sibling) => sibling.id === anchor.id)
      const insertionIndex = anchorIndex + (placement.after !== undefined ? 1 : 0)
      const sortKey = sortKeyBetween(
        siblings[insertionIndex - 1]?.sortKey ?? null,
        siblings[insertionIndex]?.sortKey ?? null,
      )
      const draft = await this.store.draftOrThrow(row.id)
      draft.sortKey = sortKey
      return await this.store.persist(draft, { touch: false })
    })
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
  private async compactSortKeys(scope: readonly SortScopeRow[]): Promise<void> {
    const ordered = this.orderedSortRows(scope)
    const keys = spreadSortKeys(ordered.length)
    const moving = ordered.flatMap((row, i) => {
      const next = keys[i]
      return next === undefined || row.sortKey === next ? [] : [{ id: row.id, next }]
    })
    if (moving.length === 0) return
    // The scope is read narrow; each row that actually moves is read whole once
    // and drafted before its key is written [POD-3259].
    const full = await this.store.rowsByIds(moving.map((m) => m.id))
    const changed: IssueRow[] = []
    for (const { id, next } of moving) {
      const row = full.get(id)
      if (!row) continue
      const draft = this.store.draftOf(row)
      draft.sortKey = next
      changed.push(draft)
    }
    if (changed.length === 0) return
    // `touch: false` for the same reason the reorder itself carries it: a scope
    // repair is organizational, and stamping `updatedAt` across a repo would
    // mark every issue in it unread (POD-325).
    await this.store.persistManyWith(
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
  private async mintSortKey(
    repoId: RepoId,
    repoPath: string,
    parentId: string | null,
    /** Whose list the new task tops: its assignee's (POD-6291). Pins are per
     *  member, so "the unpinned rows" is always somebody's. */
    assignee: UserId,
  ): Promise<string> {
    // Measured over the unpinned rows, renumbered over the whole key space —
    // see `sortScopeRows` for why those two sets differ.
    let min = this.minSortKey(
      await this.sortScopeRows(repoId, repoPath, parentId, { unpinnedFor: assignee }),
    )
    if (min !== null && min.length >= SORT_KEY_COMPACT_LEN) {
      await this.compactSortKeys(await this.sortKeySpaceRows(repoId, repoPath, parentId))
      min = this.minSortKey(
        await this.sortScopeRows(repoId, repoPath, parentId, { unpinnedFor: assignee }),
      )
    }
    return sortKeyBetween(null, min)
  }

  /** `--profile <name|id>` → the profile id (POD-6107), or a refusal naming
   *  the profiles that exist. `none` is not handled here; the CLI sends null. */
  async agentProfileIdFor(ref: string): Promise<string> {
    const profiles = this.store.d.agentProfiles
    if (!profiles) throw new IssueRefusal('agent profiles are not available on this server')
    const found = await profiles.find(ref)
    if (!found) {
      throw new IssueRefusal(`no agent profile '${ref}' — see \`podium profile list\``)
    }
    return found.id
  }

  /** Turns the input-only `agentProfile` (name, id or null) into the row field. */
  private async resolveAgentProfilePatch(patch: IssuePatch): Promise<IssuePatch> {
    if (!('agentProfile' in patch)) return patch
    const { agentProfile, ...rest } = patch
    if (agentProfile === undefined) return rest
    return {
      ...rest,
      agentProfileId: agentProfile === null ? null : await this.agentProfileIdFor(agentProfile),
    }
  }

  /**
   * Whether moving an issue from harness `from` to `to` changes the harness its
   * stored model/effort were picked for, so they must reset [spec:SP-7ff1]. An
   * `auto` side counts as the Settings harness it resolves to (POD-6133): naming
   * the default harness on an `auto` issue is no switch, as it was when create
   * froze that harness into the row.
   */
  async switchesHarness(from: string, to: string): Promise<boolean> {
    if (from === to) return false
    const settings = await this.store.deps.getSettings()
    return (
      resolveSpawnDefaults(settings, { agentKind: from }).agentKind !==
      resolveSpawnDefaults(settings, { agentKind: to }).agentKind
    )
  }

  /**
   * The parent an issue in `repoPath` is cut from when the caller named none
   * [POD-2065]: the repository's base branch, else the instance default — both as
   * configured, unprobed, so a missing one is the start refusal's to explain —
   * else, with neither set, the repository's detected base. Detection probes the
   * machine that holds the source repo, which is where a start resolves the start
   * point before shipping it to a pinned target.
   */
  private async defaultParentBranch(
    repoId: RepoId,
    repoPath: string,
    machineId: MachineId | null | undefined,
  ): Promise<string> {
    const repoDefault = await this.store.deps.store.repos.defaultParentBranchForRepoId(repoId)
    if (repoDefault) return repoDefault
    const configured = (await this.store.deps.getSettings()).gitWorkflow.defaultParentBranch.trim()
    if (configured) return configured
    const readRepo = this.store.deps.readRepo
    if (!readRepo) return 'main'
    // Ask a machine that reported THIS repository at this path: the same path on
    // another machine can be a different repository with a different base. With no
    // such machine there is nobody to ask — routing by path alone could probe that
    // other repository — so the issue takes `main`, and start explains if it lacks it.
    const at = await this.store.deps.store.repos.reportingMachineFor(repoId, repoPath, machineId)
    if (!at) return 'main'
    return await defaultParentBranchFor((op, cwd, args) => readRepo(op, cwd, args, at), repoPath)
  }

  async create(input: CreateIssueInput): Promise<IssueProjection> {
    if ((input as { stage?: string }).stage === 'shipping') {
      throw new IssueRefusal('shipping stage is system-owned and requires a ship order')
    }
    // Same gate as `update` below, at the other door an issue can be homed
    // through (`podium issue create --machine`, the new-issue dialog):
    // POD-2700 §2.5 lists issue homing as an enforcement site, and refusing only
    // one of the two entry points is how a guard becomes decorative.
    if (input.machineId != null) await this.store.d.requireIssueHomeMachine?.(input.machineId)
    // Server-minted ids are unique by construction; a client-minted optimistic
    // insert is not. Refuse it before allocating a sequence or touching storage:
    // IssuesRepository upserts by id for ordinary updates, so allowing create to
    // reach that seam would turn an additive command into an overwrite.
    if (input.id && (await readIssue(this.store.deps.store.issues, input.id)) !== null) {
      throw new IssueRefusal(`refusing to reuse an existing issue id: ${input.id}`)
    }
    // Allocate the #N off the stable repo_id so all checkouts of one origin share a
    // single sequence (#140) — resolve the path to its repo_id first, then allocate.
    const repoId = await this.store.deps.store.repos.resolveIssueRepoId(
      input.repoPath,
      input.machineId,
    )
    const seq = await this.store.deps.store.issues.nextIssueSeq(repoId)
    const ts = this.store.now()
    const agentProfileId = input.agentProfile
      ? await this.agentProfileIdFor(input.agentProfile)
      : undefined
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
      parentBranch:
        input.parentBranch ||
        (await this.defaultParentBranch(repoId, input.repoPath, input.machineId)),
      // The issue stores picks only (POD-6133): an unnamed harness, model or effort
      // stays `auto`, so the profile and then the Settings current at each
      // session start decide it, and a stored harness is always a real pick.
      defaultAgent: input.defaultAgent || 'auto',
      defaultModel: input.defaultModel || 'auto',
      defaultEffort: input.defaultEffort || 'auto',
      ...(agentProfileId ? { agentProfileId } : {}),
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
      // No `assignee`: a new task's assignee is its owner, the creating human
      // (POD-6287). The column is only a legacy display label now.
      // Keyed into the scope it will LAND in: the parent's children when this
      // is a subtask create (parentId is applied after persist via reparent,
      // so the scope is resolved from the input here).
      sortKey: await this.mintSortKey(
        repoId,
        input.repoPath,
        input.parentId ? await this.store.resolveRef(input.parentId, input.repoPath) : null,
        input.ownerUserId ?? (await firstAdminMemberId(this.store.deps.store)),
      ),
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
    // A CREATE IS A DRAFT WITH NO PREDECESSOR [POD-3259]: pinning it to `null`
    // makes `upsertIssue` refuse rather than overwrite if a row with this id
    // somehow already exists by the time the write reaches the database.
    const row: IssueRow = this.store.registerNewDraft(
      toStorage(issue, { repoPath: input.repoPath }),
    )
    // THE OWNER, WHEN THE CALLER DID NOT NAME ONE. It spelled the raw literal
    // `'user:sole'` until A2 — a string this build compiled in, which after the
    // migration names no member, so a row created without an owner would be
    // owned by nobody and visible to nobody. Resolved now, like every other
    // ambient site; a caller that knows whose issue it is still says so.
    row.ownerUserId = input.ownerUserId ?? (await firstAdminMemberId(this.store.deps.store))
    row.visibility = input.visibility ?? 'personal'
    row.createdByActor = input.createdByActor ?? row.ownerUserId
    row.createdByOnBehalfOf = input.createdByOnBehalfOf ?? row.ownerUserId
    // parentId handled after persist via reparent (edge-maintaining): the row
    // must exist first so wouldCycle/rowOrThrow find it.
    // The first text of each field is its first revision, the creator's (POD-6289).
    let wire = await this.store.persist(row, {
      afterWrite: async (committed) =>
        await this.recordTextRevisions(
          committed,
          { description: '', brief: '' },
          {
            actor: committed.createdByActor ?? null,
            onBehalfOf: committed.createdByOnBehalfOf ?? null,
            source: 'create',
            restoredFrom: null,
          },
        ),
    })
    // New list MEMBERSHIP: single-issue deltas only patch known ids on legacy
    // clients, so a create still fans out the full list once (#22).

    await this.store.emitEvent('issue.created', row.id, { seq: row.seq, title: row.title })
    // Creating a task starts it for the creating human (POD-6290): their own
    // start, or their agent's when an agent created it for them.
    if (row.createdByOnBehalfOf) {
      await this.store.recordParticipation(
        row.id,
        row.createdByOnBehalfOf,
        row.createdByActor && row.createdByActor !== row.createdByOnBehalfOf ? 'agent' : 'start',
      )
    }
    // Created FOR someone else: that person gets an "assigned to you" row.
    if (row.ownerUserId && row.createdByOnBehalfOf && row.ownerUserId !== row.createdByOnBehalfOf) {
      await this.store.recordAssignment(row.id, row.ownerUserId, row.createdByOnBehalfOf)
    }
    // Best-effort, isolated: an observer must never fail a create.
    try {
      this.store.deps.onIssueCreated?.({
        issueId: row.id,
        title: row.title,
        ownerUserId: row.ownerUserId,
      })
    } catch {}
    if (input.parentId) wire = await this.hierarchy().reparent(row.id, input.parentId)
    if (input.labels?.length) wire = await this.setLabels(row.id, input.labels)
    const parentId = (await this.store.row(row.id))?.parentId
    if (parentId && input.startedBySession) {
      await this.takeCoordinatorOnFirstChild(parentId, row.id, input.startedBySession)
    }
    return wire
  }

  /** Stage-machine normalization (issue #24) — the rules live in @podium/model's
   *  `normalizeClosedPatch` (see its doc for the three broken states it prevents). */
  private normalizeClosedPatch(row: IssueRow, patch: IssuePatch): IssuePatch {
    return normalizeClosedPatch(row, patch)
  }

  async update(
    id: string,
    patch: IssuePatch,
    /** The session that initiated this mutation, when known (agent CLI relay).
     *  Threaded onto the issue.closed / issue.ready events it emits so the steward
     *  can skip nudging the very session that caused them (self-nudge is noise).
     *  `cascadeArchive: false` keeps the close-sweep from also taking every
     *  living descendant — that walk is reserved for an explicit archive.
     *
     *  `repoPath` is INTERNAL and deliberately not part of {@link IssuePatch}:
     *  only {@link IssueWorkflow.rehome} sets it, and it is threaded here rather
     *  than assigned onto the map's row beforehand because a row a caller
     *  mutates before this method's commit is the exact shape POD-3259 removes.
     *  Widening `IssuePatch` instead would let the router move an issue between
     *  repositories, which is a different decision.
     *
     *  `clearSuggestion` is INTERNAL for the same reason and answers the same
     *  question: only {@link applySuggestion} and {@link dismissSuggestion} may
     *  retire the assistant's suggestion, so it is not in {@link IssuePatch} —
     *  putting it there would let the router and the CLI write the field the
     *  assistant owns. It exists because applySuggestion has to clear the
     *  suggestion AND move the stage as ONE write: clearing it on a draft of its
     *  own and then delegating the stage here cut a SECOND draft from the
     *  committed row, and the cleared fields went with the discarded first one
     *  (POD-3373). Two writes instead would publish the halfway row — suggestion
     *  gone, stage not yet moved — and burn a revision on it. */
    opts?: {
      actorSessionId?: SessionId
      cascadeArchive?: boolean
      repoPath?: string
      clearSuggestion?: boolean
      /** Whose pin a `pinned` patch sets (POD-6288): the calling member.
       *  Absent = the task's assignee, for the server's own updates (POD-6291). */
      viewer?: UserId
      /**
       * The human this write acts for, when a person or their agent made it
       * (POD-6287). A close stops this person's sessions on the task and
       * nobody else's; absent, it stops the assignee's. A reassignment is
       * attributed to them.
       */
      caller?: UserId
      /**
       * REASSIGN (POD-6287, design §2.2/§4.3): make this member the task's
       * assignee, its owner. INTERNAL, like `repoPath`: the command layer has
       * already resolved `me`, checked the member is active and refused an
       * agent, so nothing here re-decides who may. Written in the same draft
       * as the rest of the patch, under its revision pin.
       */
      owner?: UserId
      /**
       * WHO WROTE THIS (POD-6289): the actor (a member, or `session:<id>` for
       * an agent) and the human it acted for. A description or brief change is
       * recorded as a revision under it. Absent = the server's own write,
       * recorded as `caller` (or nobody) with no separate actor.
       */
      attribution?: { actor: string | null; onBehalfOf: string | null }
      /** INTERNAL: this write restores that recorded text (POD-6289). Only
       *  {@link restoreTextRevision} sets it. */
      restoredFrom?: number
    },
  ): Promise<IssueProjection> {
    // Resolved BEFORE the draft is cut: a lookup by name, never a row field.
    patch = await this.resolveAgentProfilePatch(patch)
    const row = await this.store.draft(await this.store.resolveRef(id))
    if (!row) throw new IssueNotFound(id)
    if (row.deletedAt) throw new IssueRefusal(`issue ${id} is deleted and cannot be updated`)
    // `shipping` is lifecycle custody, not an ordinary board value. The
    // purpose-built Shipping service owns both directions; every existing
    // update/claim/start path converges here and is therefore unable to enter or
    // leave the stage accidentally.
    if (
      (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) ||
      patch.stage === 'shipping'
    ) {
      throw new IssueRefusal(
        'shipping stage is system-owned and cannot be changed by an issue update',
      )
    }
    if (opts?.repoPath !== undefined) row.repoPath = opts.repoPath
    if (opts?.clearSuggestion) {
      row.suggestedStage = null
      row.suggestedReason = null
    }
    const prevStage = row.stage
    const wasClosed = this.store.isClosed(row)
    if (patch.stage === 'review' && row.stage !== 'review') {
      this.assertReviewArtifactOwnership(row)
    }
    patch = this.normalizeClosedPatch(row, patch)
    // CHOOSING A PROFILE HANDS IT THE AGENT PICK (POD-6107). The issue's own
    // fields go ON TOP of the profile, so a harness left over from before (the
    // create-time default included) would filter the profile's candidates down
    // to itself. Any field this same patch names still wins.
    if (patch.agentProfileId && patch.agentProfileId !== (row.agentProfileId ?? null)) {
      patch = {
        ...patch,
        ...(!('defaultAgent' in patch) ? { defaultAgent: 'auto' } : {}),
        ...(!('defaultModel' in patch) ? { defaultModel: 'auto' } : {}),
        ...(!('defaultEffort' in patch) ? { defaultEffort: 'auto' } : {}),
      }
    }
    if (
      patch.defaultAgent !== undefined &&
      patch.defaultAgent !== row.defaultAgent &&
      (await this.switchesHarness(row.defaultAgent, patch.defaultAgent))
    ) {
      patch = {
        ...patch,
        ...(!('defaultModel' in patch) ? { defaultModel: 'auto' } : {}),
        ...(!('defaultEffort' in patch) ? { defaultEffort: 'auto' } : {}),
      } // [spec:SP-7ff1]
    }
    // Attention-state before-values (issue #124): every pin/defer/archive path funnels
    // through update() (dedicated methods just call it), so a single before/after diff
    // here is the one place these transitions are detected and their events emitted.
    // WHOSE pin (POD-6291): the calling member's, else the assignee's.
    const pinner = opts?.viewer ?? row.ownerUserId
    const prevPinned = (await this.store.issueOverlay(row.id, pinner)).pinned
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
      await this.store.d.requireIssueHomeMachine?.(rowPatch.machineId)
    }
    if (
      rowPatch.worktreePath &&
      (
        await this.store.d.store.repos.listRepos(rowPatch.machineId ?? row.machineId ?? undefined)
      ).some((repo) => sameWorktreePath(repo.path, rowPatch.worktreePath as string))
    ) {
      throw new IssueRefusal(
        `refusing worktree path ${rowPatch.worktreePath}: a repository root cannot be recorded as an issue worktree`,
      )
    }
    // POD-2178: a phase takes no blocked-by edge (addDep refuses it), so a
    // retype must not smuggle one in on a task that already has one.
    if (rowPatch.type === 'phase' && row.type !== 'phase') {
      const issues = this.store.deps.store.issues
      const edged =
        (await issues.listIssueDeps(row.id)).some((d) => d.type === 'blocked-by') ||
        (await issues.listDependents(row.id)).some((d) => d.type === 'blocked-by')
      if (edged)
        throw new IssueRefusal(
          `${id} has a blocked-by edge; phases only group tasks and take none. Remove it with dep-remove first, or keep it a task`,
        )
    }

    // The texts before this patch, for the revision history (POD-6289).
    const textBefore = issueTexts(row)
    if (pinnedPatch !== undefined) {
      // Re-pinning keeps the ORIGINAL stamp, same rule as the tuck-away.
      if (pinner === undefined) throw new IssueRefusal(`issue ${id} has no member to pin it for`)
      const prevPinnedAt = (await this.store.issueUserState(row.id, pinner))?.pinnedAt ?? null
      await this.store.writeIssueUserState(
        row.id,
        { pinnedAt: pinnedPatch ? (prevPinnedAt ?? this.store.now()) : null },
        pinner,
      )
    }
    if ('parentId' in rowPatch) {
      await this.hierarchy().setParentForUpdate(
        row,
        rowPatch.parentId == null ? null : await this.store.resolveRef(rowPatch.parentId),
      )
      const { parentId: _ignored, ...rest } = rowPatch
      Object.assign(row, rest)
    } else {
      Object.assign(row, rowPatch)
    }
    const previousOwner = row.ownerUserId
    const reassigned = opts?.owner !== undefined && opts.owner !== previousOwner
    if (reassigned) row.ownerUserId = opts.owner
    // `update` is also an adoption seam for worktrees reported by a harness or
    // supplied by an operator. Only a patch that actually supplies a worktree can
    // establish placement; unrelated updates must not guess for historical NULL rows.
    if ('worktreePath' in rowPatch && row.worktreePath !== null && row.machineId === null) {
      row.machineId = await this.store.resolveWorktreeMachine(undefined, row.worktreePath)
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
      // AFTER THE COMMIT, not inside the span [POD-3806]. `refreshGitState`
      // opens with a 10ms coalescing timer, and a timer callback INHERITS the
      // async scope it was scheduled in — so from inside a span the probe wakes
      // up still addressing a transaction frame that has since committed and
      // released its lease. Every store read it makes is refused as stale, its
      // own `try/catch` swallows the refusal, and the retarget silently never
      // re-probes: the row keeps describing a base that no longer applies, which
      // is the exact failure POD-576 added this refresh to prevent.
      const retargeted = row.id
      afterCommit(() => {
        void this.gitWorkflow()
          .refreshGitState(retargeted)
          .catch(() => {})
      }, 'issue-git-state-retarget')
    }
    // Closed-flip anchor [spec:SP-6144]: closedAt moves ONLY on actual predicate
    // flips, so post-close touches (notes, deps, steward writes) never restart
    // the sidebar's completion-decay window the way updatedAt would.
    if (!wasClosed && this.store.isClosed(row)) {
      row.closedAt = this.store.now()
      row.closedByUserId = opts?.caller ?? null
    } else if (wasClosed && !this.store.isClosed(row)) {
      row.closedAt = null
      row.closedByUserId = null
      // Reopening retires the dismissal (POD-333): reopened work must not inherit
      // a tuck from a PRIOR close, or the next time it finishes it would fold
      // itself away without the operator ever seeing it. A later close offers
      // Tuck away again. Cleared here — on the closed-predicate flip itself — so
      // every client converges on it through the same broadcast. EVERY member's
      // tuck (POD-6291): the reopen is about the task, so nobody's fold survives.
      await this.store.clearIssueMarkerForAll(row.id, 'tuckedAt')
    }
    // Organizational-only patches (pin / sortKey reorder) are not activity: do
    // not advance updatedAt past readAt or computeUnread re-marks the issue
    // unread after a purely human board edit (POD-325).
    const attribution = opts?.attribution ?? { actor: null, onBehalfOf: opts?.caller ?? null }
    let revised: IssueTextField[] = []
    const wire = await this.store.persist(row, {
      touch: isOrganizationalOnlyPatch(patch) && !reassigned ? false : undefined,
      ...(reassigned ? { reassign: true as const } : {}),
      // In the row's own transaction: the history never disagrees with the text.
      afterWrite: async (committed) => {
        revised = await this.recordTextRevisions(committed, textBefore, {
          ...attribution,
          source: opts?.restoredFrom !== undefined ? 'restore' : 'edit',
          restoredFrom: opts?.restoredFrom ?? null,
        })
      },
    })
    for (const field of revised) {
      await this.store.emitEvent('issue.text_revised', row.id, {
        seq: row.seq,
        field,
        revision: row.revision ?? null,
        actor: attribution.actor,
        by: attribution.onBehalfOf,
        ...(opts?.restoredFrom !== undefined ? { restoredFrom: opts.restoredFrom } : {}),
      })
    }
    if (reassigned && previousOwner && row.ownerUserId) {
      await this.announceReassignment(row, previousOwner, row.ownerUserId, opts?.caller)
    }
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
    // Transitions into done log as issue.closed below, not stage_changed.
    if (patch.stage != null && patch.stage !== prevStage && patch.stage !== 'done') {
      await this.store.emitEvent('issue.stage_changed', row.id, {
        seq: row.seq,
        from: prevStage,
        to: patch.stage,
        // Carried so the steward's child→parent subscriptions (e.g. child→review)
        // stay pure over the event, like issue.closed already does.
        ...(row.parentId ? { parentId: row.parentId } : {}),
        // And so those nudges can skip the session that caused the transition (#116).
        ...(opts?.actorSessionId ? { causedBySessionId: opts.actorSessionId } : {}),
        // And type nothing into another person's session (POD-6368).
        ...(opts?.caller ? { causedByUserId: opts.caller } : {}),
      })
    }
    // update() owns the closed/reopened emissions: EVERY close path funnels here
    // (close(), supersede/duplicate, board drag-to-done, CLI `update --stage done`).
    // Both derive from actual closed-predicate FLIPS: a same-state re-close stays
    // silent, while a close after a real reopen fires issue.closed again (#24 —
    // normalizeClosedPatch guarantees a reopen actually flips the predicate).
    if (wasClosed && !this.store.isClosed(row)) {
      await this.store.emitEvent('issue.reopened', row.id, {
        seq: row.seq,
        ...(row.parentId ? { parentId: row.parentId } : {}),
        ...(opts?.actorSessionId ? { causedBySessionId: opts.actorSessionId } : {}),
        ...(opts?.caller ? { causedByUserId: opts.caller } : {}),
      })
    }
    let readyFanoutFailure: unknown
    if (!wasClosed && this.store.isClosed(row)) {
      await this.store.emitEvent('issue.closed', row.id, {
        seq: row.seq,
        reason: row.closedReason ?? 'done',
        // Carried so the steward's trigger rules stay pure over the event
        // (parent-nudge keys on parentId without a service lookup).
        ...(row.parentId ? { parentId: row.parentId } : {}),
        ...(opts?.actorSessionId ? { causedBySessionId: opts.actorSessionId } : {}),
        // The human behind the close (POD-6368): the steward types its nudge
        // only into that human's sessions.
        ...(opts?.caller ? { causedByUserId: opts.caller } : {}),
      })
      // Closing completes the work: retire standing agent offers so a
      // delegate's "Merge / Send back" cannot demand a decision forever after
      // the coordinator finished through another session (POD-290).
      await this.attention().retireIssueOffers(row)
      // AWAITED [POD-3820]. The hook opens its own store work; dropping the
      // promise inside this span is the shape that wedged the lock queue
      // (POD-3802). Awaiting is cheap: the cleanup registers its own tail with
      // `afterCommit` and returns, so the close still does not wait for the
      // worktree stop.
      const closedBy = opts?.caller ?? row.ownerUserId
      if (closedBy) await this.onIssueClosed?.({ issueId: row.id, closedBy })

      try {
        // AWAITED inside the try: with no span open the follow-up runs here and
        // rejects here, and an unawaited call would settle outside this catch
        // and be reported as an unhandled rejection instead of as the fanout
        // failure the tail below re-raises (POD-3499).
        await this.emitReadyAfterClose(row, opts?.actorSessionId, opts?.caller)
      } catch (error) {
        // Keep running the rest of this already-committed tail. The durable
        // follow-up error still reaches the caller below, after sibling cleanup
        // and transition events have had their turn.
        readyFanoutFailure = error
      }
      await this.archiveClosedSubtree(row.id, opts?.caller)
    }
    // Attention-state transitions S3 renders (issue #124). Emit only on an actual
    // change so a re-pin / re-archive / re-defer-to-same-time never duplicates.
    // A pin is a transition of ONE member's marker (POD-6291): the event names
    // that member, and the task's shared activity shows it to nobody else.
    const nowPinned = (await this.store.issueOverlay(row.id, pinner)).pinned
    if (nowPinned !== prevPinned && pinner !== undefined) {
      await this.store.emitEvent('issue.pinned', row.id, {
        seq: row.seq,
        pinned: nowPinned,
        userId: pinner,
      })
    }
    if (row.archived !== prevArchived && row.archived) {
      await this.store.emitEvent('issue.archived', row.id, { seq: row.seq })
      // Stops the member sessions AND gives the checkout back (POD-567); the
      // sweep's own archive path calls the same seam. Only the archiver's own
      // sessions (POD-6368): another member's stay as they were.
      await this.attention().onIssueArchived(row, opts?.caller)
      // Explicit archive dismisses the whole subtree so children do not
      // promote into the live list as orphans of a hidden parent.
      if (opts?.cascadeArchive !== false) await this.archiveLivingDescendants(row.id, opts?.caller)
    }
    if (row.deferUntil !== prevDeferUntil) {
      if (row.deferUntil != null) {
        await this.store.emitEvent('issue.snoozed', row.id, { seq: row.seq, until: row.deferUntil })
      } else {
        await this.store.emitEvent('issue.unsnoozed', row.id, { seq: row.seq })
      }
    }
    if (readyFanoutFailure) throw readyFanoutFailure
    return wire
  }

  /** Stored artifacts were authorized and snapshotted into this issue's store
   * at publication. Only old live-path entries still depend on a checkout. */
  private assertReviewArtifactOwnership(row: IssueRow): void {
    const artifacts = this.store.parsePanel(row).artifacts
    if (artifacts.length === 0) return
    const ordinary = artifacts.filter((artifact) => !artifact.artifactId)
    if (!row.worktreePath && ordinary.length > 0) {
      throw new IssueRefusal(
        `review blocked: issue ${row.seq} has artifacts but no owning worktree; restore the issue worktree and re-add the evidence`,
      )
    }
    if (!row.worktreePath) return
    const root = row.worktreePath
    for (const artifact of artifacts) {
      if (artifact.artifactId) continue
      const rel = machinePathRelativeToRoot(root, artifact.path)
      if (!rel) {
        throw new IssueRefusal(
          `review blocked: artifact '${artifact.path}' is outside the owning issue worktree ${row.worktreePath}; re-add it from that worktree`,
        )
      }
    }
  }

  /** Publish only the actor's read cursor and issue.read event. Automatic
   * receipts carry the observed activity; an explicit mark-read still covers
   * now, this issue's updates, descendants and their sessions (POD-912). */
  /**
   * Append a revision for each task text this write changed (POD-6289). On a
   * task from before this history, the first change also records the text it
   * replaced as its `baseline`, whose author is unknown. Runs inside the
   * row's transaction. Returns the fields it recorded.
   */
  private async recordTextRevisions(
    row: IssueRow,
    before: Record<IssueTextField, string>,
    rev: {
      actor: string | null
      onBehalfOf: string | null
      source: 'create' | 'edit' | 'restore'
      restoredFrom: number | null
    },
  ): Promise<IssueTextField[]> {
    const issues = this.store.deps.store.issues
    const after = issueTexts(row)
    const at = this.store.now()
    const recorded: IssueTextField[] = []
    for (const field of ISSUE_TEXT_FIELDS) {
      if (after[field] === before[field]) continue
      if (rev.source !== 'create' && before[field] !== '') {
        if (!(await issues.hasIssueTextRevisions(row.id, field))) {
          await issues.appendIssueTextRevision({
            issueId: row.id,
            field,
            body: before[field],
            source: 'baseline',
            restoredFrom: null,
            issueRevision: null,
            actor: null,
            onBehalfOf: null,
            createdAt: at,
          })
        }
      }
      await issues.appendIssueTextRevision({
        issueId: row.id,
        field,
        body: after[field],
        source: rev.source,
        restoredFrom: rev.restoredFrom,
        issueRevision: row.revision ?? null,
        actor: rev.actor,
        onBehalfOf: rev.onBehalfOf,
        createdAt: at,
      })
      recorded.push(field)
    }
    return recorded
  }

  /** A task's description or brief history, oldest first (POD-6289). */
  async textRevisions(id: string, field: IssueTextField): Promise<IssueTextRevisionRow[]> {
    const row = await this.store.rowOrThrow(await this.store.resolveRef(id))
    return await this.store.deps.store.issues.listIssueTextRevisions(row.id, field)
  }

  /**
   * Put a recorded text back (POD-6289). Anyone who may edit the task may
   * restore; the restore is an ordinary edit under the caller's name, so it
   * appends a new revision (`source = 'restore'`) and rewrites none.
   */
  async restoreTextRevision(
    id: string,
    revisionId: number,
    opts: NonNullable<Parameters<IssueCrudModule['update']>[2]>,
  ): Promise<IssueProjection> {
    const issueId = await this.store.resolveRef(id)
    const revision = await this.store.deps.store.issues.getIssueTextRevision(revisionId)
    if (!revision || revision.issueId !== issueId) {
      throw new IssueRefusal(`revision ${revisionId} is not a revision of issue ${id}`)
    }
    return await this.update(
      issueId,
      { [revision.field]: revision.body },
      { ...opts, restoredFrom: revision.id },
    )
  }

  async markIssueRead(id: string, observedAt?: string, member?: UserId): Promise<IssueProjection> {
    const row = await this.store.rowOrThrow(id)
    const viewer = markerMemberOf(row, member)
    // Automatic receipts name what was actually seen, including across an
    // offline replay. Open-issue receipts avoid subtree discovery entirely;
    // read receipts never rewrite the issue.
    const previous = (await this.store.issueOverlay(row.id, viewer)).readAt
    let readAt = observedAt ?? (await this.coveringReadAt(row))
    // A quiet closed issue keeps its existing post-read retention grace. Only
    // advance to receipt time after proving there is no newer unseen activity.
    if (
      observedAt &&
      this.store.isClosed(row) &&
      (await this.coveringReadAt(row, row.updatedAt)) <= observedAt
    ) {
      const now = this.store.now()
      if (now > readAt) readAt = now
    }
    if (previous && previous >= readAt) return await this.store.projection(row)
    await this.store.writeIssueUserState(row.id, { readAt }, viewer)
    const wire = await this.store.projection(row)
    // One member's marker (POD-6291): the event names whose, see `issue.pinned`.
    await this.store.emitEvent('issue.read', row.id, { seq: row.seq, userId: viewer })
    return wire
  }

  /** The cursor that covers everything currently visible on this issue's row. */
  private async coveringReadAt(row: IssueRow, floor = this.store.now()): Promise<string> {
    // The issue and every descendant, deleted ones included, read from the
    // database one level per statement (POD-6192).
    const self = await this.store.row(row.id)
    const covered = [...(self ? [self] : []), ...(await this.store.descendantRows(row.id))]
    let latest = floor
    for (const other of covered) {
      if (other.updatedAt > latest) latest = other.updatedAt
      for (const session of await this.store.sessionsFor(other)) {
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
  async markIssueUnread(id: string, member?: UserId): Promise<IssueProjection> {
    const row = await this.store.rowOrThrow(id)
    const viewer = markerMemberOf(row, member)
    await this.store.writeIssueUserState(row.id, { readAt: null }, viewer)
    const wire = await this.store.projection(row)
    await this.store.emitEvent('issue.unread', row.id, { seq: row.seq, userId: viewer })
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
  async setIssueTucked(id: string, tucked: boolean, member?: UserId): Promise<IssueProjection> {
    const row = await this.store.draft(await this.store.resolveRef(id))
    if (!row) throw new IssueNotFound(id)
    const viewer = markerMemberOf(row, member)
    if (tucked && !this.store.isClosed(row)) throw new IssueRefusal(`issue ${id} is not finished`)
    // Re-tucking keeps the ORIGINAL stamp: a retried outbox entry (or a second
    // client pressing the same control) must not move the dismissal moment.
    // PER-USER (POD-1076): my fold is mine — tucking never hides your copy.
    const prev = (await this.store.issueOverlay(row.id, viewer)).tuckedAt
    await this.store.writeIssueUserState(
      row.id,
      { tuckedAt: tucked ? (prev ?? this.store.now()) : null },
      viewer,
    )
    return await this.store.persist(row, { touch: false })
  }

  /** Build the issue half of a cross-aggregate soft-delete without mutating
   *  memory before the durable transaction succeeds. */
  /** The remaining-sessions argument this used to take was never read
   *  [POD-3857]: both callers built a full reader-scoped projection of the
   *  fleet, filtered it, and handed it to a parameter named `_`. */
  async prepareSoftDelete(id: string): Promise<IssueLifecyclePlan> {
    id = await this.store.resolveRef(id)
    const current = await this.store.rowOrThrow(id)
    if (current.deletedAt) throw new IssueRefusal(`issue ${id} is already deleted`)
    const deletedAt = this.store.now()
    const row: IssueRow = { ...current, deletedAt, updatedAt: deletedAt }
    // Projected INSIDE write(), after upsertIssue has stamped row.revision —
    // see IssueLifecyclePlan.wire for why taking it here would be a bug.
    let committed: IssueProjection | null = null
    let companions: EntityChangeSpec[] = []
    const wire = (): IssueProjection => {
      if (!committed) {
        throw new Error(`prepareSoftDelete(${row.id}): wire() read before write() committed it`)
      }
      return committed
    }
    return {
      issueId: row.id,
      worktreePath: row.worktreePath,
      wire,
      write: async () => {
        // The prepare/apply pair has always been draft-then-install; POD-3259
        // gave it the precondition the rest of the registry now carries, so two
        // lifecycle plans cut from one row cannot both commit.
        await this.store.deps.store.issues.upsertIssue(row, {
          expectedRevision: current.revision ?? null,
        })
        this.store.announceWorktreeMove(row.id, worktreeOf(current), worktreeOf(row))
        // THE EVENT APPEND IS A DURABLE WRITE, SO IT RIDES THIS TRANSACTION
        // [POD-3505]. It used to sit in `apply()` behind an `await`, and
        // `apply()` is called from a SYNCHRONOUS commit-application callback
        // that cannot wait for it — so the append escaped onto a later tick and
        // was not ordered with respect to the commit whose success it reports.
        // A rolled-back span could still leave `issue.deleted` in the log.
        // `persistManyWith` already appends inside its span for exactly this
        // reason, and `purgeEmptyDraft` says it in as many words: a durable
        // write belongs where it rolls back with the transaction. Only the
        // ANNOUNCEMENT is mechanism 3, and `appendEvent` defers that itself.
        //
        // NOT `emitEvent`: its `catch {}` is best-effort, which is the wrong
        // contract in here — a swallow inside the span would leave the row
        // committed with no event and report nothing anywhere. Here the append
        // is all-or-nothing with the row, so a failure must reach the caller.
        await this.store.deps.store.events.appendEvent({
          ts: this.store.now(),
          kind: 'issue.deleted',
          subject: row.id,
          repoPath: row.repoPath ?? null,
          payload: { seq: row.seq, deletedAt },
        })
        committed = await this.store.projection(row)
        companions = await this.store.companionChanges(row)
      },
      changes: () => companions,
      publish: async () => {},
    }
  }

  /** Permanently purge the automatically-created draft abandoned by an explicit
   *  session rehome. User-facing deletion must go through IssueSessionLifecycle
   *  and never reaches this method. */
  async purgeEmptyDraft(ref: string, opts?: { keepArtifacts?: boolean }): Promise<void> {
    const id = await this.store.resolveRef(ref)
    const purged = await this.store.rowOrThrow(id)
    await this.store.deps.ledger.commit({
      write: async () => {
        // Every member's personal row for the draft goes with it (POD-6290: a
        // start writes its starter's record, so a draft always has one). The
        // table has no foreign key, so the rows are dropped by hand, and each
        // one's remove reaches its member's feed in the same commit.
        const personal = await this.store.deps.store.issues.listIssueUserStateRows(id)
        await this.store.deps.store.issues.purgeIssueUserState(id)
        // Explicit draft rehome detaches every session it can SEE before calling
        // this, but it sees them through `loadSessions()`
        // — `deleted_at IS NULL` — so a TOMBSTONED session keeps pointing at the
        // row we are about to delete, and `sessions.issue_id` has no foreign key
        // to catch it (POD-1926). Same transaction as the delete: a reference to
        // a half-deleted issue must never be observable.
        await this.store.deps.store.sessions.detachTombstonesFromIssue(id)
        await this.store.deps.store.issues.deleteIssue(id)
        this.store.announceWorktreeMove(purged.id, worktreeOf(purged), null)
        return personal.map((state) => state.userId)
      },
      changes: (owners) => [
        { entity: 'issueProjection', id, op: 'remove' },
        ...owners.map((userId) => ({
          entity: 'issueUserState' as const,
          id: issueUserStateRowId(userId, id),
          op: 'remove' as const,
        })),
      ],
    })
    // The full-list tail reconciles BOTH kinds (POD-796), so the purge reaches
    // the normalized feed as the remove reconcile derives from full truth. It
    // stays INSIDE the span: `reconcileAndPublish` appends change ROWS through
    // `ledger.reconcile`, a durable write that belongs where it rolls back with
    // the transaction. It reads the database inside the span (POD-6158), so it
    // sees the delete and its ON DELETE SET NULL cascade.
    await this.store.reconcileAndPublish()
    // Hard delete: drop any artifact snapshots too ([spec:SP-0fc9], best-effort).
    // Awaited: a retry that reuses the client-minted id must not move files
    // into a directory this is still deleting (POD-2148).
    // Kept when a chat upload could not be handed back: the dir may hold its
    // only copy, and a retry under this id re-adopts it in place.
    if (!opts?.keepArtifacts) await this.store.deps.artifacts?.removeIssue(id).catch(() => {})
  }

  /** Build the issue half of a cross-aggregate restore without exposing the row
   *  before its issue and session tombstones have committed together. */
  /** Same as {@link prepareSoftDelete}: the session list was never read. */
  async prepareRestore(id: string): Promise<IssueLifecyclePlan> {
    id = await this.store.resolveRef(id)
    const current = await this.store.rowOrThrow(id)
    if (!current.deletedAt) throw new IssueRefusal(`issue ${id} is not deleted`)
    const restoredAt = this.store.now()
    const row: IssueRow = { ...current, deletedAt: null, updatedAt: restoredAt }
    // Projected INSIDE write() — see prepareSoftDelete / IssueLifecyclePlan.wire.
    let committed: IssueProjection | null = null
    let companions: EntityChangeSpec[] = []
    const wire = (): IssueProjection => {
      if (!committed) {
        throw new Error(`prepareRestore(${row.id}): wire() read before write() committed it`)
      }
      return committed
    }
    return {
      issueId: row.id,
      worktreePath: row.worktreePath,
      wire,
      write: async () => {
        // The prepare/apply pair has always been draft-then-install; POD-3259
        // gave it the precondition the rest of the registry now carries, so two
        // lifecycle plans cut from one row cannot both commit.
        await this.store.deps.store.issues.upsertIssue(row, {
          expectedRevision: current.revision ?? null,
        })
        this.store.announceWorktreeMove(row.id, worktreeOf(current), worktreeOf(row))
        // Same as prepareSoftDelete, in the other direction: the append is a
        // durable write and belongs inside the span [POD-3505].
        await this.store.deps.store.events.appendEvent({
          ts: this.store.now(),
          kind: 'issue.restored',
          subject: row.id,
          repoPath: row.repoPath ?? null,
          payload: { seq: row.seq, restoredAt },
        })
        committed = await this.store.projection(row)
        companions = await this.store.companionChanges(row)
      },
      changes: () => companions,
      publish: async () => {},
    }
  }

  /**
   * Refuse names that are not in the label vocabulary unless the caller may
   * create labels (POD-6106, D3). Agents pick from the list `prime` shows; a
   * new label is a deliberate `--create-label`, so a typo never becomes one.
   */
  async refuseUnknownLabels(
    names: readonly string[] | undefined,
    mayCreate: boolean,
  ): Promise<void> {
    if (mayCreate || !names?.length) return
    const repo = this.store.deps.store.issues
    const found = await repo.findLabels(names)
    const missing = [...new Set(names.map((n) => n.trim()).filter(Boolean))].filter(
      (n) => !found.has(n.toLowerCase()),
    )
    if (missing.length === 0) return
    const known = (await repo.listLabels()).map((l) => l.name)
    throw new IssueRefusal(
      `unknown label${missing.length === 1 ? '' : 's'} ${missing.map((m) => `"${m}"`).join(', ')}. ` +
        `Existing labels: ${known.join(', ') || '(none yet)'}. Use one of those, or pass ` +
        '`--create-label` to add a new one.',
    )
  }

  async setLabels(id: string, labels: string[]): Promise<IssueProjection> {
    id = await this.store.resolveRef(id)
    const row = await this.store.draftOrThrow(id)
    return await this.store.persistWith(
      row,
      async () => await this.store.deps.store.issues.setIssueLabels(asIssueId(id), labels),
    )
  }

  async defer(id: string, until: string | null): Promise<IssueProjection> {
    return await this.update(id, { deferUntil: until })
  }

  /** Manually end a snooze (issue #133). Rather than clearing deferUntil to null —
   *  which drops the issue quietly back into the middle of WORK with no signal — this
   *  backdates deferUntil to just-past, landing the issue in the exact "returned from
   *  defer" state a naturally-lapsed snooze reaches: derived `deferred`/`isIssueDeferred`
   *  go false while `issueReturnedFromDefer` goes true, floating it to the TOP of WORK
   *  with the "Unsnoozed" tag until the operator next opens it (the sidebar clears the
   *  stale defer on open). Emits issue.unsnoozed directly — routing a past deferUntil
   *  through update() would misfire issue.snoozed. No-op when the issue isn't deferred. */
  async undefer(id: string): Promise<IssueProjection> {
    const row = await this.store.draft(await this.store.resolveRef(id))
    if (!row) throw new IssueNotFound(id)
    if (row.deferUntil == null) return await this.store.projection(row)
    row.deferUntil = new Date(Date.parse(this.store.now()) - UNSNOOZE_BACKDATE_MS).toISOString()
    const wire = await this.store.persist(row)
    await this.store.emitEvent('issue.unsnoozed', row.id, { seq: row.seq })
    return wire
  }

  async setNeedsHuman(
    id: string,
    question?: string | null,
    /** Structured question metadata (issue #53): suggested answers for the Tray's
     *  answer chips + the asking session. askedAt is stamped here (now()) — a
     *  re-flag replaces the WHOLE pending question, metadata included. */
    meta?: { options?: string[]; askedBy?: SessionId; attribution?: Attribution },
  ): Promise<IssueProjection> {
    const wasFlagged = (await this.store.row(await this.store.resolveRef(id)))?.needsHuman === true
    const options = meta?.options?.map((o) => o.trim()).filter(Boolean) ?? []
    const wire = await this.update(id, {
      needsHuman: true,
      humanQuestion: question ?? null,
      humanQuestionOptions: options.length > 0 ? options : null,
      humanQuestionAskedBy: meta?.askedBy ?? null,
      humanQuestionAskedAt: this.store.now(),
      humanQuestionAttribution: meta?.attribution ?? null,
    })
    // Emit only on the false→true flip — a re-flag must not duplicate the event.
    if (!wasFlagged) {
      const parentId = (await this.store.row(wire.id))?.parentId
      await this.store.emitEvent('issue.needs_human', wire.id, {
        seq: wire.seq,
        question: question ?? null,
        ...(options.length > 0 ? { options } : {}),
        ...(meta?.askedBy ? { askedBy: meta.askedBy } : {}),
        // Carried so a child needing a human can notify its parent's sessions,
        // and only its asker's human's (POD-6368).
        ...(parentId ? { parentId } : {}),
        ...(meta?.attribution?.onBehalfOf ? { causedByUserId: meta.attribution.onBehalfOf } : {}),
      })
    }
    return wire
  }

  async clearNeedsHuman(id: string): Promise<IssueProjection> {
    const wasFlagged = (await this.store.row(await this.store.resolveRef(id)))?.needsHuman === true
    const wire = await this.update(id, {
      needsHuman: false,
      humanQuestion: null,
      humanQuestionOptions: null,
      humanQuestionAskedBy: null,
      humanQuestionAskedAt: null,
      humanQuestionAttribution: null,
    })
    if (wasFlagged)
      await this.store.emitEvent('issue.needs_human_cleared', wire.id, { seq: wire.seq })
    return wire
  }

  /** A session becomes its issue's coordinator when it first splits that issue
   *  (POD-6108, ANALYSIS.md D3): the first child it creates under its OWN issue
   *  takes an empty seat. A filled seat — a handover, or a dangling historical id —
   *  is never replaced here; `coordinator --claim/--set/--clear` move it. */
  private async takeCoordinatorOnFirstChild(
    parentId: IssueId,
    childId: IssueId,
    sessionId: SessionId,
  ): Promise<void> {
    const parent = await this.store.row(parentId)
    if (!parent || parent.coordinatorSessionId) return
    const self = (await this.store.factsFor(parent)).find((s) => s.sessionId === sessionId)
    if (!self) return
    // Implicitly only for the task's own assignee's session (POD-6296): Bob's
    // agent splitting Alice's task does not take her seat; it claims it only
    // on purpose (`coordinator --claim`), and then acts for Bob alone.
    if (self.ownerUserId !== parent.ownerUserId) return
    await this.setCoordinator(parent.id, sessionId, { cause: 'first-child', childId })
  }

  /** Is `userId` a member who can act: a `users` row, not disabled (POD-6287).
   *  Only such a member can be a task's assignee. */
  async isActiveMember(userId: string): Promise<boolean> {
    return (await this.store.deps.store.users.get(asUserId(userId))) !== undefined
  }

  /**
   * CLAIM (POD-6287): start work on the task. It moves the stage, and only a
   * person's claim names an assignee (`owner`, already resolved by the command
   * layer). An agent's claim never touches who is accountable for the task.
   */
  async claim(
    id: string,
    opts?: {
      actorSessionId?: SessionId
      owner?: UserId
      caller?: UserId
      /** How the claim enters the caller's personal set (POD-6290): a person's
       *  claim is a join, their agent's claim is the agent's. */
      participation?: 'join' | 'agent'
    },
  ): Promise<IssueProjection> {
    const { participation, ...rest } = opts ?? {}
    const wire = await this.update(id, { stage: 'in_progress' }, rest)
    if (participation && rest.caller) {
      await this.store.recordParticipation(wire.id, rest.caller, participation)
    }
    return wire
  }

  /**
   * The reassignment's two durable traces, after its write committed: an
   * attributed `issue.reassigned` event and a notice in the old and the new
   * assignee's inbox. Sessions, credentials, approvals and spending are not
   * touched: existing work keeps running for whoever started it (§2.3).
   */
  private async announceReassignment(
    row: IssueRow,
    from: UserId,
    to: UserId,
    by: UserId | undefined,
  ): Promise<void> {
    await this.store.emitEvent('issue.reassigned', row.id, {
      seq: row.seq,
      from,
      to,
      ...(by ? { by } : {}),
    })
    // The new assignee's removable "assigned to you by X" row (POD-6290); the
    // old assignee's assigned row goes, their start or join record stays.
    await this.store.recordAssignment(row.id, to, by ?? null, from)
    if (by) {
      await this.store.deps.onIssueReassigned?.({
        issueId: row.id,
        seq: row.seq,
        title: row.title,
        from,
        to,
        by,
      })
    }
  }

  /** Claim / set / clear the issue's designated coordinator session
   *  (docs/agent-comms-target.html §05 q1). Bare session id; null clears.
   *  Dangling-tolerant: we do not validate the session still exists — if it is
   *  later deleted, actionable mail falls back to selectMailNudgeSession and the
   *  seat rule stops counting it. Every change lands in the issue history. */
  async setCoordinator(
    id: string,
    sessionId: SessionId | null,
    why: { cause: 'first-child'; childId: IssueId } | { cause: 'set' } = { cause: 'set' },
  ): Promise<IssueProjection> {
    const before =
      (await this.store.row(await this.store.resolveRef(id)))?.coordinatorSessionId ?? null
    const wire = await this.update(id, { coordinatorSessionId: sessionId })
    if (before !== sessionId) {
      await this.store.emitEvent('issue.coordinator_set', wire.id, {
        seq: wire.seq,
        sessionId,
        ...(before ? { from: before } : {}),
        ...why,
      })
    }
    return wire
  }

  async close(
    id: string,
    reason = 'done',
    opts?: { actorSessionId?: SessionId; caller?: UserId },
  ): Promise<IssueProjection> {
    // update() emits issue.closed; actorSessionId rides through so the steward
    // can skip nudging the session that requested the close.
    //
    // CANONICALIZED ON WRITE (POD-1074): a caller that still says `wontfix`
    // stores `cancelled`, so the vocabulary stops growing new legacy rows. An
    // unrecognized reason is stored VERBATIM — the column is deliberately free
    // text and an integration with its own word for an ending should not have
    // it silently rewritten to "done".
    const canonical = canonicalIssueCloseReason(reason) ?? reason
    return await this.update(id, { stage: 'done', closedReason: canonical }, opts)
  }

  async applySuggestion(id: string): Promise<IssueProjection> {
    const row = await this.store.draftOrThrow(id)
    if (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) {
      throw new IssueRefusal('shipping stage is system-owned and cannot apply an issue suggestion')
    }
    const stage = row.suggestedStage
    // Route the stage move through update() so the #24 closed-state normalization
    // (and its closed/reopened event flips) applies — a suggested reopen must not
    // recreate the stage-only bimodal state.
    //
    // The clearing rides along as `clearSuggestion` rather than being assigned to
    // `row` first, because update() cuts its OWN draft from the committed row: a
    // field written here would be discarded with this draft, and the user would
    // see the stage move while the suggestion and its reason stayed on screen
    // (POD-3373). Under the pre-draft shared-row model the assignment was visible
    // to update() through the shared object, which is why this read as correct.
    if (stage) return await this.update(row.id, { stage }, { clearSuggestion: true })
    // No suggested stage to apply: there is nothing for update() to do, so this
    // draft is the only writer and clears the reason on its own.
    row.suggestedStage = null
    row.suggestedReason = null
    return await this.store.persistRow(row)
  }
  async dismissSuggestion(id: string): Promise<IssueProjection> {
    const row = await this.store.draftOrThrow(id)
    if (isIssueStage(row.stage) && isSystemOwnedIssueStage(row.stage)) {
      throw new IssueRefusal(
        'shipping stage is system-owned and cannot dismiss an issue suggestion',
      )
    }
    row.suggestedStage = null
    row.suggestedReason = null
    return await this.store.persistRow(row)
  }
}

/**
 * WHOSE MARKER a marker command writes (POD-6291): the member it acts for, else
 * — the server acting for itself — the task's assignee. Never the first admin.
 */
function markerMemberOf(
  row: Pick<IssueRow, 'id' | 'ownerUserId'>,
  member: UserId | undefined,
): UserId {
  const owner = member ?? row.ownerUserId
  if (owner === undefined) throw new IssueRefusal(`issue ${row.id} has no member to mark it for`)
  return owner
}
