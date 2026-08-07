import {
  asMachineId,
  asUserId,
  DEFER_NEXT_MESSAGE,
  type IssueWire,
  type SessionId,
  type SessionMeta,
  spawnedByTag,
} from '@podium/model'
import { formatIssueRef } from '@podium/protocol'
import { resolveRole } from '@podium/runtime'
import type { CommandPrincipal } from '../../../command-principal'
import { liveSessionsUsingWorktree, sessionsForIssue } from '../../../issue-util'
import { type LinearIssue, searchIssues } from '../../../linear'
import { assertModelSelectionValid } from '../../../model-validation'
import type { IssueRow } from '../../../store'
import { findSessionById } from '../../sessions/session-by-id'
import { issueRefsPattern, probeGitState } from '../git-state'
import { IssueAssistantDigestModule } from './assistant'
import type { IssueAttentionModule } from './attention'
import type { IssueStore } from './core'
import type { IssueCrudModule } from './crud'
import { IssueEpicIntegrationModule } from './integration'
import type { IssueCommentsMailModule } from './mail'
import type { CreateIssueInput } from './types'

/** Issues whose merge axis is a live question [POD-384]: a private worktree on a
 *  branch, still in the worklist. A shared checkout has no merge axis; an issue
 *  without a worktree has nowhere to probe from; and an archived or deleted row
 *  is off the sidebar, so a stale `ahead` on it strands nothing and buying a
 *  probe for it would let the fan-out grow with history instead of with work. */
function watchesParentBranch(row: IssueRow): boolean {
  return (
    !row.deletedAt &&
    !row.archived &&
    row.worktreePath !== null &&
    row.branch !== null &&
    // No parent branch, nothing to watch it move against — and `rev-parse ''`
    // is a round trip to the daemon to be told so, every tick.
    row.parentBranch !== ''
  )
}

/** Group key for {@link IssueGitWorkflowModule.sweepParentBranchMovement}: every
 *  issue sharing one machine's copy of one repo's watched ref is answered by a
 *  single `rev-parse`. JSON so no separator can collide with a path. The third
 *  slot is the watched ref (cut parent and/or landing base — see the sweep). */
function parentBranchKey(machineId: string | null | undefined, repoPath: string, ref: string): string {
  return JSON.stringify([machineId ?? '', repoPath, ref])
}

/** What one {@link parentBranchKey} group carries into the sweep: the machine/
 *  repo/ref the `rev-parse` needs, plus the issues answered by it. */
type ParentBranchGroup = {
  repoPath: string
  /** The ref under watch — either an issue's parentBranch or the landing base. */
  watchedRef: string
  machineId: string | null
  ids: string[]
}

/** Default branch work lands on when an issue's cut parent is not itself the
 *  shared integration branch. Mirrors create-time fallback in crud.ts. */
function landingBaseFromSettings(defaultParentBranch: string | undefined): string {
  const trimmed = defaultParentBranch?.trim() ?? ''
  return trimmed !== '' ? trimmed : 'main'
}

/**
 * Git-workflow capability: ONE issue's git life — worktree start/cleanup, PR/merge
 * actions, extra sessions, Linear search, and the per-session git projection whose
 * debounce this module owns. Epic integration (#70) and the LLM activity digest are
 * reached through their own modules ({@link IssueEpicIntegrationModule},
 * {@link IssueAssistantDigestModule}); the delegates below are what keeps their
 * callers on one object.
 *
 * `freeWorktreeKeepBranch`, `cleanup` and `integrate` take an explicit
 * {@link CommandPrincipal} (POD-1344). The authenticated transport had the
 * caller all along; this plane used to drop it and stamp `system:<job>` on the
 * six addComment sites below (POD-1315's honest interim). Callers that truly
 * have no human — tests and in-process jobs — still pass `systemPrincipal`,
 * but every registry/tRPC and session-stop entry hands through the real
 * principal so comments name who asked.
 */
export class IssueGitWorkflowModule {
  /** The activity digest, reached only through its own module (POD-1606). */
  private readonly assistant: IssueAssistantDigestModule
  /** Epic integration, reached only through its own module (POD-417). */
  private readonly integration: IssueEpicIntegrationModule

  constructor(
    readonly store: IssueStore,
    private readonly crud: () => Pick<IssueCrudModule, 'update' | 'create' | 'close' | 'defer'>,
    private readonly commentsMail: () => Pick<IssueCommentsMailModule, 'addComment'>,
    private readonly attention: () => Pick<IssueAttentionModule, 'setNeedsHuman'>,
  ) {
    // The activity digest is a SECOND job that shared this owner only because both
    // are triggered by session activity (POD-1606). Assigned here rather than at the
    // declaration so it is an injected collaborator, not owned state.
    this.assistant = new IssueAssistantDigestModule(store)
    // Epic integration was a THIRD (POD-417): a batch over an epic's children's
    // branches, holding its own in-flight guard and touching none of the git
    // projection state below. Same treatment — a collaborator, not owned state.
    this.integration = new IssueEpicIntegrationModule(store, commentsMail, attention)
    // Capability methods are also handed to lifecycle ports as callbacks. Keep
    // the module as the receiver so its per-instance timers and git-attribution
    // maps can never fall through to undefined or leak into module-global state.
    this.rehome = this.rehome.bind(this)
    this.start = this.start.bind(this)
    this.createAndMaybeStart = this.createAndMaybeStart.bind(this)
    this.action = this.action.bind(this)
    this.freeWorktreeKeepBranch = this.freeWorktreeKeepBranch.bind(this)
    this.releaseWorktreeIfIdle = this.releaseWorktreeIfIdle.bind(this)
    this.ensureWorktree = this.ensureWorktree.bind(this)
    this.cleanup = this.cleanup.bind(this)
    this.integrate = this.integrate.bind(this)
    this.addSession = this.addSession.bind(this)
    this.addShell = this.addShell.bind(this)
    this.linearSearch = this.linearSearch.bind(this)
    this.onSessionAttention = this.onSessionAttention.bind(this)
    this.onSessionActivity = this.onSessionActivity.bind(this)
    this.recordSessionGitActivity = this.recordSessionGitActivity.bind(this)
    this.onSessionTurnEnd = this.onSessionTurnEnd.bind(this)
    this.onSessionRemovedOrArchived = this.onSessionRemovedOrArchived.bind(this)
    this.refreshGitState = this.refreshGitState.bind(this)
    this.refreshAssistant = this.refreshAssistant.bind(this)
  }
  /**
   * Move an issue's home to another machine after its session was handed off
   * ([spec:SP-3f7a], POD-824). The target worktree is where the work now lives,
   * and this trio is what the user sees: the file-browser root, the sidebar's
   * selected worktree, and the cwd a NEW agent on this issue spawns into.
   *
   * All three move together or none do. `repoPath` is deliberately absent from
   * `IssuePatch` — it is not a free-form field — but it IS machine-specific, so
   * leaving it on the source while `machineId` points at the target yields an
   * issue that cannot start: `requireMachineForRepo` rejects a path that machine
   * has never registered, and `worktreePathFor` would site the next worktree
   * under the source's path. Hence one guarded transition rather than a patch.
   *
   * Identity is unaffected: the nice-id prefix and repo scoping both resolve
   * through `repoId` (`prefixForPath` → `resolveRepoIdForPath` → `prefixForRepoId`),
   * which is origin-derived and identical on both machines — so POD-779 stays
   * POD-779. Refuses a target repo whose identity differs, which would silently
   * renumber the issue into another repo.
   */
  rehome(
    id: string,
    to: { machineId: string; repoPath: string; worktreePath: string },
  ): IssueWire | null {
    const row = this.store.rows.get(this.store.resolveRef(id))
    if (!row) return null
    if (!this.isSameRepoIdentity(row, to.repoPath)) return null
    row.repoPath = to.repoPath
    return this.crud().update(id, {
      machineId: asMachineId(to.machineId),
      worktreePath: to.worktreePath,
    })
  }

  /**
   * Is `toRepoPath` the SAME repository this issue already belongs to (POD-1461)?
   *
   * Identity is origin-derived via repoId, so it survives two machines having two
   * layouts — /home/mgw/src/podium here, /home/till/src/podium there. Extracted from
   * {@link rehome} so the machine-pinned START applies the same rule rather than a
   * second copy: a target repo with a different identity would silently renumber the
   * issue into another repo, and that must be refused on BOTH paths that move an issue
   * between machines, not just the one that happened to be written first.
   */
  private isSameRepoIdentity(row: IssueRow, toRepoPath: string): boolean {
    const repos = this.store.d.store.repos
    const from = row.repoId ?? repos.resolveRepoIdForPath(row.repoPath)
    const target = repos.resolveRepoIdForPath(toRepoPath)
    return Boolean(target) && (!from || from === target)
  }

  private worktreePathFor(repoPath: string, branch: string): string {
    // branch is `issue/<seq>-<slug>`; flatten to a directory name under <repo>/.worktrees
    const dir = branch.replace(/\//g, '-')
    return `${repoPath}/.worktrees/${dir}`
  }

  /**
   * The model/effort a spawn on this issue should actually run.
   *
   * `stored` is the issue's profile; the sanitizer drops a stored value that is merely
   * the INHERITED coding-role default when the spawn is on a different harness, since
   * one harness's slug is meaningless on another.
   *
   * `override` is an explicit per-launch choice (`issue start --model/--effort`,
   * POD-1545) and bypasses the sanitizer entirely: an explicit value was not inherited
   * from anything, so there is nothing to sanitize, and dropping it would be the
   * parsed-then-silently-ignored failure this exists to avoid. Precedence, therefore:
   * explicit flag > issue's stored value > `auto`.
   */
  private selectionFor(
    agentKind: string,
    stored: { agent: string; model: string; effort: string },
    override?: { model?: string; effort?: string },
  ): { model: string; effort: string } {
    const settings = this.store.d.getSettings()
    const coding = resolveRole(settings, 'coding')
    const usesIssueProfile = agentKind === stored.agent
    const inherited = (value: string, roleValue: string): string =>
      usesIssueProfile && (agentKind === coding.harness || value !== roleValue) ? value : 'auto'
    return {
      model: override?.model ?? inherited(stored.model, settings.roles.coding.model),
      effort: override?.effort ?? inherited(stored.effort, settings.roles.coding.effort),
    }
  }

  async start(
    id: string,
    agentKind?: string,
    opts?: {
      spawnedBy?: string
      forceUnknownModel?: boolean
      /** Explicit per-launch model/effort (POD-1545). Beats the issue's stored value
       *  and PERSISTS onto the issue, so every later spawn on it agrees. */
      model?: string
      effort?: string
    },
  ): Promise<
    IssueWire &
      Partial<{
        agentId: string
        harness: string
        model: string | null
        effort: string | null
        machine: string
      }>
  > {
    const row = this.store.rowOrThrow(id)
    if (row.worktreePath) {
      // Starting a started issue is a deliberate no-op. But a caller who passed an
      // explicit --model/--effort asked for something this no-op will not do, and
      // accepting it in silence is the same failure one level up: the operator sees
      // `started #n` and believes the choice landed. Refuse, and name what does work.
      if (opts?.model || opts?.effort) {
        throw new Error(
          `#${row.seq} is already started — --model/--effort apply only to the session start spawns. ` +
            `Use \`podium issue update --id ${row.seq} --model/--effort\` to change the issue's profile, ` +
            `then \`podium issue add-session ${row.seq}\` to spawn a session that runs it.`,
        )
      }
      return this.store.toWire(row)
    }
    // Switching harness at start discards the stored model/effort: they were chosen
    // for the OLD harness and its slugs mean nothing on the new one.
    const switching = Boolean(agentKind && agentKind !== row.defaultAgent)
    const agent = agentKind ?? row.defaultAgent
    const stored = {
      agent,
      model: switching ? 'auto' : row.defaultModel,
      effort: switching ? 'auto' : row.defaultEffort,
    }
    const selection = this.selectionFor(agent, stored, {
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.effort ? { effort: opts.effort } : {}),
    })
    // Reject an unavailable model/effort BEFORE mutating any start state (worktree,
    // branch, stage, and the issue's own profile) [spec:SP-cc60]. Resolving the whole
    // selection above rather than writing it to `row` first is what makes that true of
    // the PROFILE too: a refused `--model` must not be left sitting on the issue for
    // the next start to inherit silently.
    // Catalog is machine-keyed (POD-1123): validate against the issue's host.
    assertModelSelectionValid(
      this.store.d.store.settings.getModelCatalog(
        row.machineId ?? this.store.d.store.hostMachineId,
      ),
      {
        agentKind: agent,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { effort: selection.effort } : {}),
        ...(opts?.forceUnknownModel ? { force: true } : {}),
      },
    )
    // Accepted — commit the selection to the issue. `--model`/`--effort` PERSIST here
    // (documented as such in `start --help`), matching `--agent` above: the issue's
    // profile is what add-session and every later respawn read, so a launch-only
    // override would give one issue two answers to "what does this run at".
    row.defaultAgent = agent
    row.defaultModel = opts?.model ?? stored.model
    row.defaultEffort = opts?.effort ?? stored.effort

    // Branch preserved after free/archive (worktreePath null, branch set): attach the
    // existing branch — do NOT `worktree add -b`, which fails because the branch is
    // still there. Same rebuild as resume (`ensureWorktree` → worktreeAddExisting).
    // Fresh starts (no branch) take the create path below.
    let path: string
    if (row.branch) {
      const ensured = await this.ensureWorktree(id)
      if (!ensured.ok || !ensured.worktreePath) {
        throw new Error(ensured.output || 'failed to recreate worktree from branch')
      }
      path = ensured.worktreePath
    } else {
      /**
       * A machine-pinned start has to reach the target BEFORE the worktree add (POD-1424).
       *
       * Two things had to be true and neither was. The repository has to be resolved by
       * IDENTITY, because two machines have two layouts and comparing the source path
       * literally made a present repo read as absent; and the start point has to EXIST
       * there, because `worktree add <path> <startPoint>` fails on a start point the
       * target cannot resolve — and our own branches are on no shared remote, so a clone
       * cannot fetch them.
       *
       * ORDER IS THE PROPERTY. This runs first and the worktree add uses the path it
       * returns: the repo path on the TARGET, which is not `row.repoPath`.
       * requireMachineForRepo keeps its job and now runs AFTER, against the resolved path,
       * so what it still catches — an offline machine — is exactly what it has an
       * actionable message for.
       *
       * The move is committed through `rehome` rather than by assigning `row.repoPath`
       * here, because repoPath and machineId have to travel together — the file-browser
       * root, the sidebar's worktree and the cwd the next agent spawns into are all
       * derived from the pair, and `rehome` is the guarded transition that already moves
       * them as one.
       */
      let startRepoPath = row.repoPath
      let startPoint = row.parentBranch
      if (row.machineId && this.store.d.prepareMachineStart) {
        const prepared = await this.store.d.prepareMachineStart({
          repoPath: row.repoPath,
          machineId: row.machineId,
          ...(row.parentBranch ? { startPoint: row.parentBranch } : {}),
        })
        startRepoPath = prepared.repoPath
        // A bundled branch lands as OBJECTS, not as a ref, so the branch name does not
        // resolve on the target even though its commit does. prepareMachineStart hands
        // back whatever the target can actually resolve — the name when it was already
        // there, a commit id when it had to be shipped.
        if (prepared.startPoint) startPoint = prepared.startPoint
      }
      // Refuse a foreign repository BEFORE creating anything (POD-1461). The same identity
      // rule rehome applies: a target whose repoId differs would renumber this issue into
      // another repo. Checked here rather than after the add, so a refusal costs nothing.
      if (startRepoPath !== row.repoPath && !this.isSameRepoIdentity(row, startRepoPath)) {
        throw new Error(
          `refusing to start on ${startRepoPath}: it is not the same repository as ${row.repoPath}`,
        )
      }
      if (row.machineId) this.store.d.requireMachineForRepo?.(row.machineId, startRepoPath)
      const branch = this.store.slug(row.seq, row.title)
      path = this.worktreePathFor(startRepoPath, branch)
      const res = await this.store.d.repoOp(
        'worktreeAdd',
        startRepoPath,
        { path, branch, ...(startPoint ? { startPoint } : {}) },
        row.machineId ?? undefined,
      )
      if (!res.ok) throw new Error(`worktree add failed: ${res.output}`)
      // POD-665: the daemon just created this worktree out from under connected
      // clients — nudge them to re-fetch repos rather than sit invisible until reload.
      this.store.d.onWorktreesChanged?.(row.repoPath, row.machineId ?? undefined)
      row.branch = branch
      row.worktreePath = path
      /**
       * repoPath TRAVELS WITH the worktree (POD-1461).
       *
       * Leaving it on the source produced an inconsistent row — repoPath on one machine,
       * worktreePath and machineId on another — and every later operation that derives a
       * path from that pair then sent one machine's path to the other. Observed: stopping
       * such a session ran `git -C <source>/podium worktree remove <target>/...` and died
       * with "Permission denied", orphaning the checkout on the target.
       *
       * Handoff never had this bug because it commits through rehome, which moves the pair
       * as one. This is the same move, so it obeys the same rule; the identity guard above
       * is rehome's, applied before anything was built.
       */
      row.repoPath = startRepoPath
    }
    // Starting a CLOSED issue is an explicit reopen (#24): clear the closed
    // markers so the issue doesn't get a live worktree while staying
    // derived-closed (invisible to ready/open). Emitted as issue.reopened so
    // the closed-predicate flip is observable like every other reopen path.
    const wasClosed = this.store.isClosed(row)
    if (wasClosed) {
      row.closedReason = null
      row.closedAt = null
      row.supersededBy = null
      row.duplicateOf = null
      // …including the tuck-away dismissal (POD-333), same as update()'s reopen:
      // work picked back up must not carry a stale fold into its next close.
      // PER-USER (POD-1076): clears the broadcast viewer's fold, which is what
      // this cleared when the stamp was a column.
      this.store.writeIssueUserState(row.id, { tuckedAt: null })
    }
    row.stage = 'in_progress'
    // `assignee` is a branded `UserId` by POD-361's recorded decision ('free text
    // today, inventory §9'), and an `agent:<kind>` tag is not a user. The cast is
    // named rather than hidden: adjudicating whether the column holds a UserId or
    // an actor TAG is POD-1075's (accounts) call, not this sweep's.
    row.assignee = asUserId(`agent:${row.defaultAgent}`)
    const wire = this.store.persistRow(row)
    if (wasClosed) {
      this.store.broadcastList() // reopen flip: dependents' blocked/ready changed (#22)
      this.store.emitEvent('issue.reopened', row.id, {
        seq: row.seq,
        ...(row.parentId ? { parentId: row.parentId } : {}),
      })
    }
    this.store.emitEvent('issue.started', row.id, {
      seq: row.seq,
      branch: row.branch,
      worktreePath: row.worktreePath,
    })
    // The human summary leads; the technical brief follows verbatim. [spec:SP-6144]
    const initialPrompt = [row.description.trim(), row.brief ?? ''].filter(Boolean).join('\n\n')
    const spawned = this.store.d.spawnSession({
      cwd: path,
      issueId: row.id,
      agentKind: row.defaultAgent,
      model: selection.model,
      effort: selection.effort,
      ...(opts?.forceUnknownModel ? { forceUnknownModel: true } : {}),
      ...(initialPrompt ? { initialPrompt } : {}),
      spawnedBy: opts?.spawnedBy ?? spawnedByTag({ kind: 'issue', id: row.id }),
      ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
      ...(row.machineId ? { machineId: row.machineId } : {}),
    })
    return {
      ...wire,
      agentId: spawned.agentId ?? spawned.sessionId,
      harness: spawned.harness ?? row.defaultAgent,
      model:
        spawned.model === undefined
          ? selection.model === 'auto'
            ? null
            : selection.model
          : spawned.model,
      effort:
        spawned.effort === undefined
          ? selection.effort === 'auto'
            ? null
            : selection.effort
          : spawned.effort,
      machine: spawned.machine,
    }
  }

  async createAndMaybeStart(
    input: CreateIssueInput,
    opts?: { spawnedBy?: string },
  ): Promise<IssueWire> {
    const created = this.crud().create(input)
    return input.startNow ? this.start(created.id, undefined, opts) : created
  }

  async action(
    id: string,
    kind: 'rebase' | 'pr' | 'merge',
  ): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const row = this.store.rowOrThrow(id)
    if (!row.worktreePath || !row.branch) throw new Error('issue not started')
    const gw = this.store.d.getSettings().gitWorkflow
    if (kind === 'rebase') {
      const r = await this.store.d.repoOp('rebase', row.worktreePath, {
        parentBranch: row.parentBranch,
      })
      return { ...r, issue: this.store.toWire(row) }
    }
    if (kind === 'pr') {
      const r = await this.store.d.repoOp('prCreate', row.worktreePath, {
        branch: row.branch,
        parentBranch: row.parentBranch,
      })
      if (r.ok) {
        const url = r.output.match(/https?:\/\/\S+/)?.[0]
        if (url) row.prUrl = url
      }
      return { ...r, issue: this.store.persistRow(row) }
    }
    // merge
    if (gw.autoRebaseBeforeMerge) {
      const rb = await this.store.d.repoOp('rebase', row.worktreePath, {
        parentBranch: row.parentBranch,
      })
      if (!rb.ok) return { ...rb, issue: this.store.toWire(row) }
    }
    // mergeFfOnly runs on the repo root (parent-branch checkout), NOT the worktree.
    // The daemon's `git merge --ff-only <branch>` merges into whatever branch the repo
    // ROOT currently has checked out. We must NOT auto-checkout the parent branch — the
    // repo root is the LIVE deployment-source checkout and switching its branch can
    // crash-loop the backend. Instead, GUARD: only merge if the root is already on the
    // parent branch; otherwise fail clearly without merging.
    const st = await this.store.d.repoOp('status', row.repoPath)
    const current = this.parseCurrentBranch(st.output)
    if (current !== row.parentBranch) {
      return {
        ok: false,
        output: `repo root at ${row.repoPath} is on '${current}', not the parent branch '${row.parentBranch}'. Check out ${row.parentBranch} there before merging.`,
        issue: this.store.toWire(row),
      }
    }
    const r = await this.store.d.repoOp('mergeFfOnly', row.repoPath, { branch: row.branch })
    if (r.ok) {
      const issue = this.crud().close(id, 'done')
      // This branch just landed [POD-384]: settle its merge axis now, so the
      // operator who pressed merge sees the "ready to merge" chip go rather than
      // watching it outlive the merge until the next watch tick. Siblings whose
      // own counts moved are the watch's job, not this action's.
      void this.refreshGitState(id).catch(() => {})
      return { ...r, issue }
    }
    return { ...r, issue: this.store.toWire(row) }
  }

  /**
   * Free an issue's working copy while KEEPING its branch [spec:SP-9904].
   * Used by session/issue stop so a finished agent can release the worktree
   * without discarding reversible work on the branch. Does NOT require the
   * issue to be closed (unlike cleanup). Caller is responsible for the
   * unsaved-work guard (dirty tree without --force) and for ensuring no live
   * sessions still use this worktree.
   *
   * `principal` is who asked for the free (POD-1344) — stamped onto the audit
   * comment. Author stays `system:stop` (job label); actor/onBehalfOf name the
   * caller.
   */
  async freeWorktreeKeepBranch(
    id: string,
    principal: CommandPrincipal,
    opts?: { force?: boolean },
  ): Promise<{ ok: boolean; output: string; issue: IssueWire; worktreeFreed: boolean }> {
    const row = this.store.rowOrThrow(id)
    const refuse = (
      output: string,
    ): { ok: boolean; output: string; issue: IssueWire; worktreeFreed: boolean } => ({
      ok: false,
      output,
      issue: this.store.toWire(row),
      worktreeFreed: false,
    })
    if (!row.worktreePath) {
      return {
        ok: true,
        output: row.branch
          ? `no worktree on disk; branch '${row.branch}' kept`
          : 'no worktree/branch recorded',
        issue: this.store.toWire(row),
        worktreeFreed: false,
      }
    }
    if (!row.branch) {
      return refuse('refusing free: worktree recorded but no branch — resolve manually')
    }
    const worktreePath = row.worktreePath
    const branch = row.branch
    const machineId = row.machineId ?? undefined
    // Always route git ops to the issue's machine — a remote-owned worktree must
    // not be inspected/removed against the hub's local path [spec:SP-9904].
    const st = await this.store.d.repoOp('status', worktreePath, undefined, machineId)
    // Already gone on disk — clear the path of record, keep the branch.
    if (!st.ok && /cannot change to .*: no such file or directory/i.test(st.output)) {
      row.worktreePath = null
      this.store.persistRow(row)
      this.store.d.onWorktreesChanged?.(row.repoPath, machineId)
      return {
        ok: true,
        output: `worktree already gone at ${worktreePath}; branch '${branch}' kept`,
        issue: this.store.toWire(row),
        worktreeFreed: true,
      }
    }
    if (!st.ok) {
      return refuse(`refusing free: cannot inspect worktree: ${st.output}`)
    }
    const dirty = st.output.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('## '))
    if (dirty.length > 0 && !opts?.force) {
      return refuse(
        `refusing free: worktree has unsaved changes (re-run with --force to discard the working copy; branch is kept either way):\n${dirty.join('\n')}`,
      )
    }
    const wr = await this.store.d.repoOp(
      'worktreeRemove',
      row.repoPath,
      {
        path: worktreePath,
        ...(opts?.force ? { force: '1' } : {}),
      },
      machineId,
    )
    if (!wr.ok) return refuse(`worktree remove failed: ${wr.output}`)
    row.worktreePath = null
    this.store.persistRow(row)
    this.store.d.onWorktreesChanged?.(row.repoPath, machineId)
    const issue = this.commentsMail().addComment(
      row.id,
      'system:stop',
      `stop: freed worktree ${worktreePath}; branch '${branch}' kept for resume/inspect`,
      principal,
    )
    this.store.emitEvent('issue.worktree_freed', row.id, {
      seq: row.seq,
      worktreePath,
      branch,
      forced: opts?.force === true,
    })
    return {
      ok: true,
      output: `freed ${worktreePath}; branch '${branch}' kept`,
      issue,
      worktreeFreed: true,
    }
  }

  /**
   * Give a finished issue's disk back, keeping everything reversible (POD-567).
   *
   * The GUARDED wrapper around {@link freeWorktreeKeepBranch}: it is the whole
   * automatic path, so it is where "automatic never destroys work" is enforced
   * rather than at each caller. Three rules, and they are the reason this is one
   * function instead of a copied block:
   *
   * - **Never `force`.** A dirty tree refuses and stays on disk. Uncommitted work
   *   is the one thing with no second copy, so an unattended job must leave it
   *   exactly where its author left it and say so.
   * - **No live session may be standing in the path** — checked by *path*, not by
   *   issue, because a session attached to a DIFFERENT issue can be sitting in
   *   this worktree and removing it underneath one is the same data loss.
   * - **The branch is kept unconditionally, unmerged included.** That is not a
   *   refusal case, it is the merge-pending case: the branch holds the work and
   *   `ensureWorktree` rebuilds the checkout on resume.
   *
   * A refusal is REPORTED, never swallowed: it returns its reason and emits
   * `issue.worktree_free_refused` so "held by uncommitted changes" is a fact in
   * the log rather than a directory nobody can explain later.
   *
   * Callers: the archive seam (`IssueAttentionModule.onIssueArchived`), and the
   * closed-worktree GC sweep (POD-564) which wants exactly these gates.
   */
  async releaseWorktreeIfIdle(
    id: string,
    principal: CommandPrincipal,
  ): Promise<{ freed: boolean; reason?: string }> {
    const row = this.store.rowOrThrow(id)
    const worktreePath = row.worktreePath
    if (!worktreePath) return { freed: false }
    const stillUsing = liveSessionsUsingWorktree(worktreePath, this.store.d.listSessions())
    if (stillUsing.length > 0) {
      return this.refuseRelease(
        row,
        worktreePath,
        `${stillUsing.length} live session(s) still in ${worktreePath}`,
      )
    }
    // NO force — deliberately not plumbed as an option. See the rules above.
    const freed = await this.freeWorktreeKeepBranch(id, principal)
    if (!freed.ok) return this.refuseRelease(row, worktreePath, freed.output)
    return { freed: freed.worktreeFreed }
  }

  private refuseRelease(
    row: IssueRow,
    worktreePath: string,
    reason: string,
  ): { freed: false; reason: string } {
    this.store.emitEvent('issue.worktree_free_refused', row.id, {
      seq: row.seq,
      worktreePath,
      reason,
    })
    return { freed: false, reason }
  }

  /**
   * The issue's repository as the PINNED machine has it (POD-1571).
   *
   * Falls back to the issue's own path on absence, deliberately: that is what makes
   * requireMachineForRepo still able to say NO, naming a path the user recognises.
   */
  private repoPathOnMachine(repoPath: string, machineId: string | null | undefined): string {
    if (!machineId) return repoPath
    return this.store.d.findRepoOnMachine?.(repoPath, machineId) ?? repoPath
  }

  /**
   * Ensure the issue's worktree exists on disk for the preserved branch
   * [spec:SP-9904]. Used on resume after stop/archive freed the working copy,
   * and by `start` / `addSession` when a NEW agent needs the same rebuild.
   * Idempotent when the worktree is already present.
   */
  async ensureWorktree(
    id: string,
  ): Promise<{ ok: boolean; output: string; worktreePath: string | null; issue: IssueWire }> {
    const row = this.store.rowOrThrow(id)
    const machineId = row.machineId ?? undefined
    if (row.worktreePath) {
      const st = await this.store.d.repoOp('status', row.worktreePath, undefined, machineId)
      if (st.ok) {
        return {
          ok: true,
          output: 'worktree already present',
          worktreePath: row.worktreePath,
          issue: this.store.toWire(row),
        }
      }
      // Path recorded but missing — fall through to recreate at the same path
      // when possible, else the canonical path for the branch.
      if (!/cannot change to .*: no such file or directory/i.test(st.output)) {
        return {
          ok: false,
          output: `cannot inspect worktree: ${st.output}`,
          worktreePath: row.worktreePath,
          issue: this.store.toWire(row),
        }
      }
    }
    if (!row.branch) {
      return {
        ok: false,
        output: 'no branch recorded — cannot recreate worktree',
        worktreePath: null,
        issue: this.store.toWire(row),
      }
    }
    // The repository is on the PINNED machine at that machine's path, which is not
    // row.repoPath when the layouts differ (POD-1571). Resolve by identity first, then
    // guard — and run the recreate itself against the resolved path, since `git -C
    // <source path>` on the target names a directory that is not there.
    const repoPath = this.repoPathOnMachine(row.repoPath, row.machineId)
    const path = row.worktreePath ?? this.worktreePathFor(repoPath, row.branch)
    if (row.machineId) this.store.d.requireMachineForRepo?.(row.machineId, repoPath)
    const res = await this.store.d.repoOp(
      'worktreeAddExisting',
      repoPath,
      { path, branch: row.branch },
      machineId,
    )
    if (!res.ok) {
      return {
        ok: false,
        output: `worktree recreate failed: ${res.output}`,
        worktreePath: null,
        issue: this.store.toWire(row),
      }
    }
    row.worktreePath = path
    this.store.persistRow(row)
    this.store.d.onWorktreesChanged?.(row.repoPath, row.machineId ?? undefined)
    return {
      ok: true,
      output: `recreated worktree ${path} from branch '${row.branch}'`,
      worktreePath: path,
      issue: this.store.toWire(row),
    }
  }

  /**
   * Guarded worktree+branch cleanup for a merged, closed issue (issue #71).
   * Every guard refuses with {ok:false, output:<reason>} and NO side effects;
   * the destructive ops themselves are non-forcing (`git worktree remove` /
   * `git branch -d` — never --force / -D), so git itself is the last guard.
   * Never touches the repo ROOT checkout: worktreeRemove/branchDelete run
   * with the root as cwd but only ever name the issue's worktree/branch.
   *
   * `principal` is who asked for cleanup (POD-1344). Author stays
   * `system:cleanup` (job label); actor/onBehalfOf name the caller.
   */
  async cleanup(
    id: string,
    principal: CommandPrincipal,
  ): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const row = this.store.rowOrThrow(id)
    const refuse = (output: string): { ok: boolean; output: string; issue: IssueWire } => ({
      ok: false,
      output,
      issue: this.store.toWire(row),
    })
    // (a) only closed issues are cleanable.
    if (!this.store.isClosed(row)) {
      return refuse(`refusing cleanup: issue #${row.seq} is still open (close it first)`)
    }
    // (b) nothing recorded → nothing to do. Branch-only state (worktree already
    //     removed, branch delete previously refused — the partial-failure retry)
    //     is VALID: fall through to the worktree-less delete path below.
    if (!row.worktreePath && !row.branch) {
      return refuse('nothing to clean up: no worktree/branch recorded on this issue')
    }
    if (!row.worktreePath && row.branch) {
      // Retry path after a partial cleanup: re-verify ancestry, then delete.
      const branch = row.branch
      const merged = await this.store.d.repoOp('isMergedInto', row.repoPath, {
        branch,
        parentBranch: row.parentBranch,
      })
      if (!merged.ok) {
        return refuse(
          `refusing cleanup: branch '${branch}' is not fully merged into '${row.parentBranch}'${merged.output ? ` (${merged.output})` : ''}`,
        )
      }
      const bd = await this.store.d.repoOp('branchDelete', row.repoPath, { branch })
      if (!bd.ok) return refuse(this.branchDeleteRefusal(branch, row.parentBranch, bd.output))
      row.branch = null
      this.store.persistRow(row)
      const issue = this.commentsMail().addComment(
        row.id,
        'system:cleanup',
        `cleanup: deleted merged branch '${branch}' (worktree was already removed)`,
        principal,
      )
      this.store.emitEvent('issue.cleaned', row.id, { seq: row.seq, worktreePath: null, branch })
      return { ok: true, output: `deleted branch ${branch}`, issue }
    }
    if (!row.branch) {
      // Worktree recorded but no branch — shouldn't happen via our flows; refuse
      // rather than guess (removing a worktree whose branch we can't verify).
      return refuse('refusing cleanup: worktree recorded but no branch — resolve manually')
    }
    const worktreePath = row.worktreePath as string
    const branch = row.branch
    // (c) worktree gone on disk (deleted out-of-band) → reconcile the columns
    //     and report; nothing destructive to run. STRICT ENOENT match only:
    //     `git -C <missing>` fails "cannot change to '<p>': No such file or
    //     directory". EACCES ("Permission denied") or "not a working tree"
    //     (files still on disk) must REFUSE, not clear a live worktree's columns.
    const st = await this.store.d.repoOp('status', worktreePath)
    if (!st.ok && /cannot change to .*: no such file or directory/i.test(st.output)) {
      row.worktreePath = null
      row.branch = null
      this.store.persistRow(row)
      const issue = this.commentsMail().addComment(
        row.id,
        'system:cleanup',
        `cleanup: worktree ${worktreePath} already gone; cleared recorded worktree/branch (${branch})`,
        principal,
      )
      this.store.emitEvent('issue.cleaned', row.id, {
        seq: row.seq,
        worktreePath,
        branch,
        alreadyGone: true,
      })
      return { ok: true, output: `already gone: ${worktreePath} (columns cleared)`, issue }
    }
    if (!st.ok) {
      const hint = /not a working tree/i.test(st.output)
        ? ' (path exists but is not a git worktree — files are still on disk; inspect and remove manually)'
        : ''
      return refuse(`refusing cleanup: cannot inspect worktree: ${st.output}${hint}`)
    }
    // (d) branch must be fully merged into the parent branch. Read-only ancestry
    //     check against the repo ROOT's ref database — exit 1 (not an ancestor)
    //     and any error both refuse.
    const merged = await this.store.d.repoOp('isMergedInto', row.repoPath, {
      branch,
      parentBranch: row.parentBranch,
    })
    if (!merged.ok) {
      return refuse(
        `refusing cleanup: branch '${branch}' is not fully merged into '${row.parentBranch}'${merged.output ? ` (${merged.output})` : ''}`,
      )
    }
    // (e) worktree must be clean (porcelain lines beyond the `## branch` header = dirty).
    const dirty = st.output.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('## '))
    if (dirty.length > 0) {
      return refuse(`refusing cleanup: worktree has uncommitted changes:\n${dirty.join('\n')}`)
    }
    // Remove the worktree (non-forcing; git may still refuse and we surface it).
    const wr = await this.store.d.repoOp('worktreeRemove', row.repoPath, { path: worktreePath })
    if (!wr.ok) return refuse(`worktree remove failed: ${wr.output}`)
    row.worktreePath = null
    this.store.persistRow(row) // columns reflect reality even if branch delete refuses below
    // Delete the branch (-d only; git refuses unmerged as a belt-and-braces guard).
    const bd = await this.store.d.repoOp('branchDelete', row.repoPath, { branch })
    if (!bd.ok) {
      const why = this.branchDeleteRefusal(branch, row.parentBranch, bd.output)
      const issue = this.commentsMail().addComment(
        row.id,
        'system:cleanup',
        `cleanup: removed worktree ${worktreePath}; branch '${branch}' NOT deleted: ${why}`,
        principal,
      )
      return {
        ok: false,
        output: `worktree ${worktreePath} removed, but branch delete refused: ${why}`,
        issue,
      }
    }
    row.branch = null
    this.store.persistRow(row)
    const issue = this.commentsMail().addComment(
      row.id,
      'system:cleanup',
      `cleanup: removed worktree ${worktreePath} and deleted merged branch '${branch}'`,
      principal,
    )
    this.store.emitEvent('issue.cleaned', row.id, { seq: row.seq, worktreePath, branch })
    return { ok: true, output: `removed ${worktreePath}; deleted branch ${branch}`, issue }
  }

  /** Rebuild an epic's integration branch — see {@link IssueEpicIntegrationModule}
   *  for why an epic-wide replay is not this module's job. Delegated so the
   *  registry, the capability interface and every caller keep the same method on
   *  the same object. */
  integrate(
    id: string,
    principal: CommandPrincipal,
  ): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    return this.integration.integrate(id, principal)
  }

  /** Explain a `git branch -d` refusal. We deliberately keep -d (never -D): for a
   *  STACKED issue (parentBranch = another issue branch) our ancestry guard passes
   *  against the parent while git's -d checks merged-into-HEAD (usually main), so
   *  -d routinely refuses. Retrying `cleanup` after the parent chain reaches the
   *  root HEAD succeeds — the branch-only retry path exists exactly for that. */
  private branchDeleteRefusal(branch: string, parentBranch: string, gitOutput: string): string {
    const stacked = /not fully merged/i.test(gitOutput)
      ? ` Note: '${branch}' IS merged into '${parentBranch}' (verified), but git -d checks the root HEAD — retry cleanup after '${parentBranch}' reaches the root branch, or delete the branch manually.`
      : ''
    return `${gitOutput}${stacked}`
  }

  /**
   * Parse the current branch from `git status --porcelain=v1 -b` output.
   * The first line is `## <branch>...<upstream>`, `## <branch>`, or
   * `## HEAD (no branch)` when detached. Returns null for detached/unparseable.
   */
  private parseCurrentBranch(statusOutput: string): string | null {
    const first = statusOutput.split('\n', 1)[0] ?? ''
    if (!first.startsWith('## ')) return null
    const rest = first.slice(3) // strip "## "
    // Detached HEAD renders as "## HEAD (no branch)".
    if (rest.startsWith('HEAD (no branch)')) return null
    // `## <branch>...<upstream>` — the branch ends at the first "...".
    const branch = (rest.split('...', 1)[0] ?? '').trim()
    return branch || null
  }

  /**
   * Spawn another agent (or shell) on an already-started issue.
   *
   * When the checkout was freed but the branch survived (stop / archive —
   * worktreePath null, branch set), rebuild via {@link ensureWorktree} first.
   * That is the same attach path resume uses; without it this threw
   * "issue not started" and left the only re-entry through an old session.
   *
   * Return type widens only on the rebuild branch (sync when the worktree is
   * already present), matching `ensureSessionWorktree` and keeping the common
   * add-session path on the wire without an extra turn.
   */
  addSession(
    id: string,
    agentKind?: string,
    opts?: { spawnedBy?: string; forceUnknownModel?: boolean },
  ): IssueWire | Promise<IssueWire> {
    const row = this.store.rowOrThrow(id)
    if (!row.worktreePath) {
      if (!row.branch) throw new Error('issue not started')
      return this.ensureWorktree(id).then((ensured) => {
        if (!ensured.ok || !ensured.worktreePath) {
          throw new Error(ensured.output || 'failed to recreate worktree from branch')
        }
        return this.spawnAddedSession(id, agentKind, opts)
      })
    }
    return this.spawnAddedSession(id, agentKind, opts)
  }

  /** Shared spawn tail once a worktree path is known to exist on the issue. */
  private spawnAddedSession(
    id: string,
    agentKind?: string,
    opts?: { spawnedBy?: string; forceUnknownModel?: boolean },
  ): IssueWire {
    const row = this.store.rowOrThrow(id)
    if (!row.worktreePath) throw new Error('issue not started')
    const kind = agentKind ?? row.defaultAgent
    const selection = this.selectionFor(kind, {
      agent: row.defaultAgent,
      model: row.defaultModel,
      effort: row.defaultEffort,
    })
    // Reject an unavailable model/effort before spawning [spec:SP-cc60]. A 'shell'
    // session carries no model (addShell), so validation is a no-op there.
    assertModelSelectionValid(
      this.store.d.store.settings.getModelCatalog(
        row.machineId ?? this.store.d.store.hostMachineId,
      ),
      {
        agentKind: kind,
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.effort ? { effort: selection.effort } : {}),
        ...(opts?.forceUnknownModel ? { force: true } : {}),
      },
    )
    // Guard against the path the repository has ON THE PIN, not the issue's own
    // (POD-1571): comparing the source path literally made a present repo read as
    // absent and refused every add-session to a machine with a different layout.
    if (row.machineId) {
      this.store.d.requireMachineForRepo?.(
        row.machineId,
        this.repoPathOnMachine(row.repoPath, row.machineId),
      )
    }
    this.store.d.spawnSession({
      cwd: row.worktreePath,
      issueId: row.id,
      agentKind: kind,
      model: selection.model,
      effort: selection.effort,
      ...(opts?.forceUnknownModel ? { forceUnknownModel: true } : {}),
      spawnedBy: opts?.spawnedBy ?? spawnedByTag({ kind: 'issue', id: row.id }),
      ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
      ...(row.machineId ? { machineId: row.machineId } : {}),
    })
    return this.store.toWire(row)
  }

  addShell(id: string, opts?: { spawnedBy?: string }): IssueWire | Promise<IssueWire> {
    return this.addSession(id, 'shell', opts)
  }

  async linearSearch(query: string): Promise<LinearIssue[]> {
    // POD-419: the material is in the server-only keyed store, not the blob.
    const key = this.store.d.store.secrets.get('integrations.linearApiKey')
    if (!key) return []
    const search = this.store.d.linearSearch ?? searchIssues
    return search(key, query)
  }

  /** A member session just ENTERED an attention phase — a new message needs the
   *  user. End any "until next message" defer on the issue(s) owning the session
   *  so they resurface exactly when there's something new (the issue mirror of a
   *  session's `snoozedUntil: null` snooze). */
  onSessionAttention(sessionId: SessionId): void {
    const sess = findSessionById(this.store.d, sessionId)
    if (!sess) return
    for (const row of [...this.store.rows.values()]) {
      if (row.deferUntil !== DEFER_NEXT_MESSAGE || row.deletedAt) continue
      if (sessionsForIssue(row.worktreePath, [sess], row.id).length > 0)
        this.crud().defer(row.id, null)
    }
  }

  /** Debounced LLM activity digest — see {@link IssueAssistantDigestModule} for why
   *  it is not part of this module's git debounce. Delegated so the registry, the
   *  session-wiring port and every caller keep the same method on the same object. */
  onSessionActivity(sessionId: SessionId): void {
    this.assistant.onSessionActivity(sessionId)
  }

  // ── git-state probes [POD-98] ─────────────────────────────────────────────
  // "Has this task committed, and on which branch?" — probed on the working→idle
  // edge (the only moment commits appear), joined into the wire as an ephemeral
  // field (core.gitStates). Attribution (which commits/files are THIS task's)
  // comes from the daemon's hook-ingest HEAD-delta capture, recorded per session
  // here and unioned per issue at probe time; without it a shared checkout runs
  // in disclosed fallback mode.
  private gitRefreshes = new Map<
    string,
    { promise: Promise<void>; rerun: boolean; fallbackCwd?: string }
  >()
  private gitCommitsBySession = new Map<string, string[]>()
  private gitTouchedBySession = new Map<string, Set<string>>()
  /** Last observed tip of every parent branch under watch, keyed by
   *  {@link parentBranchKey} — the movement detector for
   *  {@link sweepParentBranchMovement}. Ephemeral like `gitStates`, and for the
   *  same reason: it caches a git fact, never a decision. */
  private parentTips = new Map<string, string>()

  /** Daemon-captured git activity for a session: commit shas from the HEAD
   *  delta around the session's own tool call, and/or files its Edit/Write
   *  tools touched. Registers the session as attribution-capable even when
   *  both lists are empty (SessionStart baseline). */
  recordSessionGitActivity(
    sessionId: SessionId,
    activity: { commits?: string[]; touched?: string[] },
  ): void {
    const commits = this.gitCommitsBySession.get(sessionId) ?? []
    for (const sha of activity.commits ?? []) if (!commits.includes(sha)) commits.push(sha)
    this.gitCommitsBySession.set(sessionId, commits)
    const touched = this.gitTouchedBySession.get(sessionId) ?? new Set<string>()
    for (const f of activity.touched ?? []) touched.add(f)
    this.gitTouchedBySession.set(sessionId, touched)
    // A commit is the one git-state change worth a probe OUTSIDE the turn-end
    // edge — it flips the headline answer ("has it committed?") mid-turn. And
    // after a restart the ephemeral gitStates map is empty: the first hook
    // registration from a live session repopulates its issue's stamp instead
    // of leaving the UI blank until the next full turn ends.
    const resolved = this.issueForSession(sessionId)
    if (!resolved) return
    if (activity.commits?.length || !this.store.gitStates.has(resolved.row.id)) {
      void this.refreshGitState(resolved.row.id, resolved.sess.cwd).catch(() => {})
    }
  }

  /** Working→idle edge from the sessions service: refresh the git state of the
   *  issue this session works. Fire-and-forget; never throws into the caller. */
  onSessionTurnEnd(sessionId: SessionId): void {
    const resolved = this.issueForSession(sessionId)
    if (!resolved) return
    void this.refreshGitState(resolved.row.id, resolved.sess.cwd).catch(() => {})
  }

  /** A session was archived or permanently removed. Drop its ephemeral
   * attribution ledger immediately; if its issue remains visible, queue a fresh
   * derived state so commits/files from the departed session do not linger. */
  onSessionRemovedOrArchived(sessionId: SessionId): void {
    const resolved = this.issueForSession(sessionId)
    const removedCommits = this.gitCommitsBySession.delete(sessionId)
    const removedTouched = this.gitTouchedBySession.delete(sessionId)
    if ((!removedCommits && !removedTouched) || !resolved) return
    void this.refreshGitState(resolved.row.id, resolved.sess.cwd).catch(() => {})
  }

  /** The issue's human ref (`POD-98`, or `#98` before a prefix exists) — the
   *  commit-message marker logIssueCommits greps for. */
  private issueRef(row: IssueRow): string {
    const prefix = this.store.d.store.repos.prefixForPath(row.repoPath)
    return prefix ? formatIssueRef(prefix, row.seq) : `#${row.seq}`
  }

  /** The issue a session works: explicit attachment or worktree membership. */
  private issueForSession(sessionId: SessionId): { row: IssueRow; sess: SessionMeta } | null {
    const sess = findSessionById(this.store.d, sessionId)
    if (!sess) return null
    const row = [...this.store.rows.values()].find(
      (r) => !r.deletedAt && sessionsForIssue(r.worktreePath, [sess], r.id).length > 0,
    )
    return row ? { row, sess } : null
  }

  /** Queue a checkout probe. Requests arriving in the same short window share
   * one probe; requests arriving while it runs share one trailing probe, so a
   * late attribution update is never dropped. Scheduling happens before any
   * list/Git work, keeping daemon hooks and turn-end handlers fire-and-forget. */
  async refreshGitState(id: string, fallbackCwd?: string): Promise<void> {
    const active = this.gitRefreshes.get(id)
    if (active) {
      active.rerun = true
      active.fallbackCwd ??= fallbackCwd
      return active.promise
    }
    const refresh = {
      rerun: false,
      fallbackCwd,
      promise: Promise.resolve(),
    }
    refresh.promise = (async () => {
      let changed = false
      do {
        // Coalesce rapid daemon messages/turn-end edges before starting four
        // read-only repo operations. A request during the probe flips rerun and
        // is folded into exactly one trailing pass.
        await new Promise((resolve) => setTimeout(resolve, 10))
        refresh.rerun = false
        changed = (await this.probeGitStateOnce(id, refresh.fallbackCwd)) || changed
      } while (refresh.rerun)
      if (changed) {
        const current = this.store.rows.get(id)
        if (current && !current.deletedAt) this.store.broadcastIssue(current)
      }
    })().finally(() => {
      if (this.gitRefreshes.get(id) === refresh) this.gitRefreshes.delete(id)
    })
    this.gitRefreshes.set(id, refresh)
    return refresh.promise
  }

  /**
   * Parent-branch / landing-base movement watch [POD-384, POD-576].
   *
   * A merge is the one git event that SETTLES an issue's merge axis, and it
   * almost never happens anywhere the three session-scoped triggers above can
   * see it: agents are instructed to merge with `git -C <repo>` from their own
   * checkout, and a human merges from a terminal. Neither writes a commit into
   * the merged issue's worktree nor moves any of ITS sessions across a turn
   * edge, so nothing re-probes and the cached `ahead > 0` keeps a finished issue
   * out of the sidebar's closed fold indefinitely — it renders as a delivery
   * that never landed, hours after it landed.
   *
   * So watch every ref a merge might move. That is the issue's cut
   * {@link IssueRow.parentBranch} (in-app merge into the parent) AND, when the
   * issue is stacked on something other than the landing base, the landing base
   * itself (the hard-land-on-main path). A landed sibling cut-parent is the one
   * category of parent that never moves again; watching only it is structurally
   * blind to the land that actually settles the axis [POD-576].
   *
   * One `rev-parse` per (machine, repo, ref) group answers "did anything land?"
   * for every issue in that group, and only a MOVED tip costs a probe — the
   * steady state is one cheap git call per watched ref per tick.
   *
   * A tip seen for the first time is recorded, not acted on. `gitStates` is
   * ephemeral, so a fresh process holds no stale snapshot to correct, and
   * fanning out across every issue at boot would be pure cost.
   */
  async sweepParentBranchMovement(): Promise<void> {
    const landingBase = landingBaseFromSettings(
      this.store.d.getSettings().gitWorkflow.defaultParentBranch,
    )
    const groups = new Map<string, ParentBranchGroup>()
    const addToGroup = (row: IssueRow, ref: string) => {
      if (ref === '') return
      const key = parentBranchKey(row.machineId, row.repoPath, ref)
      const group = groups.get(key)
      if (group) {
        if (!group.ids.includes(row.id)) group.ids.push(row.id)
      } else {
        groups.set(key, {
          repoPath: row.repoPath,
          watchedRef: ref,
          machineId: row.machineId ?? null,
          ids: [row.id],
        })
      }
    }
    for (const row of this.store.rows.values()) {
      if (!watchesParentBranch(row)) continue
      addToGroup(row, row.parentBranch)
      // Stacked issue: also watch the landing base, because that is the ref the
      // hard land procedure moves. Without this, a dead sibling parent freezes
      // the watch forever (POD-576).
      if (row.parentBranch !== landingBase) addToGroup(row, landingBase)
    }
    // Forget tips no live issue watches any more (closed out, worktree freed) so
    // the map stays bounded by current work rather than by history.
    for (const key of [...this.parentTips.keys()]) if (!groups.has(key)) this.parentTips.delete(key)

    await Promise.all(
      [...groups].map(async ([key, group]) => {
        const res = await this.store.d
          .repoOp(
            'revParseVerify',
            group.repoPath,
            { ref: group.watchedRef },
            // The row carries "no machine" as null; the rpc reads it as undefined
            // (= pick by repo affinity). Narrowed here, at the one call, rather
            // than by giving the group its own spelling of the field.
            group.machineId ?? undefined,
          )
          .catch(() => ({ ok: false, output: '' }))
        // An unreadable watched ref (offline machine, ref not there yet) leaves
        // the last known tip intact: the next readable sweep compares against a
        // real observation instead of treating recovery as movement.
        if (!res.ok) return
        const tip = res.output.trim()
        if (tip === '') return
        const seen = this.parentTips.get(key)
        this.parentTips.set(key, tip)
        if (seen === undefined || seen === tip) return
        await Promise.all(group.ids.map((id) => this.refreshGitState(id).catch(() => {})))
      }),
    )
  }

  /** Run one coalesced probe and retain its issue's final state for publication. */
  private async probeGitStateOnce(id: string, fallbackCwd?: string): Promise<boolean> {
    const row = this.store.rows.get(id)
    if (!row || row.deletedAt) return false
    const shared = row.worktreePath === null
    const cwd = row.worktreePath ?? fallbackCwd
    if (!cwd) return false
    try {
      const members = this.store.sessionsFor(row)
      const attribution = this.gitAttributionFor(members)
      const landingBranch = landingBaseFromSettings(
        this.store.d.getSettings().gitWorkflow.defaultParentBranch,
      )
      const state = await probeGitState(
        {
          repoOp: (op, opCwd, args, machineId) =>
            this.store.d.repoOp(op as never, opCwd, args, machineId),
        },
        {
          cwd,
          shared,
          parentBranch: row.parentBranch,
          // Authoritative merge-axis ancestry target [POD-576]: where work lands,
          // not only where the branch was cut from.
          landingBranch,
          branch: row.branch,
          machineId: row.machineId ?? undefined,
          ...attribution,
          // Restart-proof task axis: commits whose message carries the issue's
          // marker ([POD-98] tag / Podium-Issue trailer) count even when the
          // in-memory ledger is empty or the commits predate capture.
          refsPattern: issueRefsPattern(this.issueRef(row)),
        },
        this.store.now(),
      )
      this.store.gitStates.set(id, state)
      return true
    } catch {
      // Probe failure leaves the last completed state intact.
      return false
    }
  }

  /** Union the attribution ledgers of an issue's member sessions. Absent (not
   *  empty) when NO member ever registered — that absence is what flips the
   *  probe into disclosed fallback mode. */
  private gitAttributionFor(members: SessionMeta[]): {
    commits?: string[]
    touched?: ReadonlySet<string>
  } {
    let seen = false
    const commits: string[] = []
    const touched = new Set<string>()
    for (const m of members) {
      const c = this.gitCommitsBySession.get(m.sessionId)
      const t = this.gitTouchedBySession.get(m.sessionId)
      if (c === undefined && t === undefined) continue
      seen = true
      for (const sha of c ?? []) if (!commits.includes(sha)) commits.push(sha)
      for (const f of t ?? []) touched.add(f)
    }
    return seen ? { commits, touched } : {}
  }

  /** The LLM activity digest — see {@link IssueAssistantDigestModule}. */
  refreshAssistant(id: string): Promise<IssueWire> {
    return this.assistant.refreshAssistant(id)
  }
}
