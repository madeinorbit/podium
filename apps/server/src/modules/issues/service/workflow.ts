import { DEFER_NEXT_MESSAGE } from '@podium/domain'
import type { IssueWire, OrphanIssue } from '@podium/protocol'
import { resolveRole } from '@podium/runtime'
import { sessionsForIssue } from '../../../issue-util'
import { buildAssistantMessages, parseAssistantJson } from '../../../issueAssistant'
import { type LinearIssue, searchIssues } from '../../../linear'
import { completeForRole } from '../../../llm-roles'
import { assertModelSelectionValid } from '../../../model-validation'
import type { IssueRow } from '../../../store'
import { IssueServiceMail } from './mail'
import type { CreateIssueInput } from './types'

/**
 * IssueService layer 5 — git workflow + assistant (issue #190 split): worktree
 * start/cleanup, PR/merge actions, epic integration (#70), extra sessions,
 * Linear search and the LLM activity digest.
 */
export abstract class IssueServiceWorkflow extends IssueServiceMail {
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
    const row = this.rows.get(this.resolveRef(id))
    if (!row) return null
    const repos = this.d.store.repos
    const from = row.repoId ?? repos.resolveRepoIdForPath(row.repoPath)
    const target = repos.resolveRepoIdForPath(to.repoPath)
    if (!target || (from && from !== target)) return null
    row.repoPath = to.repoPath
    return this.update(id, { machineId: to.machineId, worktreePath: to.worktreePath })
  }

  private worktreePathFor(repoPath: string, branch: string): string {
    // branch is `issue/<seq>-<slug>`; flatten to a directory name under <repo>/.worktrees
    const dir = branch.replace(/\//g, '-')
    return `${repoPath}/.worktrees/${dir}`
  }

  private modelSelectionFor(row: IssueRow, agentKind: string): { model: string; effort: string } {
    const settings = this.d.getSettings()
    const coding = resolveRole(settings, 'coding')
    const usesIssueProfile = agentKind === row.defaultAgent
    return {
      model:
        usesIssueProfile &&
        (agentKind === coding.harness || row.defaultModel !== settings.roles.coding.model)
          ? row.defaultModel
          : 'auto',
      effort:
        usesIssueProfile &&
        (agentKind === coding.harness || row.defaultEffort !== settings.roles.coding.effort)
          ? row.defaultEffort
          : 'auto',
    }
  }

  async start(
    id: string,
    agentKind?: string,
    opts?: { spawnedBy?: string; forceUnknownModel?: boolean },
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
    const row = this.rowOrThrow(id)
    if (row.worktreePath) return this.toWire(row) // already started
    if (agentKind && agentKind !== row.defaultAgent) {
      row.defaultAgent = agentKind
      row.defaultModel = 'auto'
      row.defaultEffort = 'auto'
    }
    const selection = this.modelSelectionFor(row, row.defaultAgent)
    // Reject an unavailable model/effort BEFORE mutating any start state (worktree,
    // branch, stage) [spec:SP-cc60] — the issue's stored defaults are the selection.
    assertModelSelectionValid(this.d.store.settings.getModelCatalog(), {
      agentKind: row.defaultAgent,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.effort ? { effort: selection.effort } : {}),
      ...(opts?.forceUnknownModel ? { force: true } : {}),
    })
    if (row.machineId) this.d.requireMachineForRepo?.(row.machineId, row.repoPath)
    const branch = this.slug(row.seq, row.title)
    const path = this.worktreePathFor(row.repoPath, branch)
    const res = await this.d.repoOp(
      'worktreeAdd',
      row.repoPath,
      { path, branch, startPoint: row.parentBranch },
      row.machineId ?? undefined,
    )
    if (!res.ok) throw new Error(`worktree add failed: ${res.output}`)
    // POD-665: the daemon just created this worktree out from under connected
    // clients — nudge them to re-fetch repos rather than sit invisible until reload.
    this.d.onWorktreesChanged?.(row.repoPath, row.machineId ?? undefined)
    // Starting a CLOSED issue is an explicit reopen (#24): clear the closed
    // markers so the issue doesn't get a live worktree while staying
    // derived-closed (invisible to ready/open). Emitted as issue.reopened so
    // the closed-predicate flip is observable like every other reopen path.
    const wasClosed = this.isClosed(row)
    if (wasClosed) {
      row.closedReason = null
      row.supersededBy = null
      row.duplicateOf = null
    }
    row.branch = branch
    row.worktreePath = path
    row.stage = 'in_progress'
    row.assignee = `agent:${row.defaultAgent}`
    const wire = this.persistRow(row)
    if (wasClosed) {
      this.broadcastList() // reopen flip: dependents' blocked/ready changed (#22)
      this.emitEvent('issue.reopened', row.id, {
        seq: row.seq,
        ...(row.parentId ? { parentId: row.parentId } : {}),
      })
    }
    this.emitEvent('issue.started', row.id, {
      seq: row.seq,
      branch: row.branch,
      worktreePath: row.worktreePath,
    })
    // Hand the agent the description as its first prompt AT SPAWN. createSession
    // delivers it via argv for claude/codex/grok (`claude "<prompt>"` — consumed at
    // startup, no TUI-readiness race) or seeds the composer draft for other agents.
    const spawned = this.d.spawnSession({
      cwd: path,
      issueId: row.id,
      agentKind: row.defaultAgent,
      model: selection.model,
      effort: selection.effort,
      ...(opts?.forceUnknownModel ? { forceUnknownModel: true } : {}),
      ...(row.description.trim() ? { initialPrompt: row.description } : {}),
      spawnedBy: opts?.spawnedBy ?? `issue:${row.id}`,
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
      machine: spawned.machine ?? row.machineId ?? '__local__',
    }
  }

  async createAndMaybeStart(
    input: CreateIssueInput,
    opts?: { spawnedBy?: string },
  ): Promise<IssueWire> {
    const created = this.create(input)
    return input.startNow ? this.start(created.id, undefined, opts) : created
  }

  async action(
    id: string,
    kind: 'rebase' | 'pr' | 'merge',
  ): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const row = this.rowOrThrow(id)
    if (!row.worktreePath || !row.branch) throw new Error('issue not started')
    const gw = this.d.getSettings().gitWorkflow
    if (kind === 'rebase') {
      const r = await this.d.repoOp('rebase', row.worktreePath, { parentBranch: row.parentBranch })
      return { ...r, issue: this.toWire(row) }
    }
    if (kind === 'pr') {
      const r = await this.d.repoOp('prCreate', row.worktreePath, {
        branch: row.branch,
        parentBranch: row.parentBranch,
      })
      if (r.ok) {
        const url = r.output.match(/https?:\/\/\S+/)?.[0]
        if (url) row.prUrl = url
      }
      return { ...r, issue: this.persistRow(row) }
    }
    // merge
    if (gw.autoRebaseBeforeMerge) {
      const rb = await this.d.repoOp('rebase', row.worktreePath, { parentBranch: row.parentBranch })
      if (!rb.ok) return { ...rb, issue: this.toWire(row) }
    }
    // mergeFfOnly runs on the repo root (parent-branch checkout), NOT the worktree.
    // The daemon's `git merge --ff-only <branch>` merges into whatever branch the repo
    // ROOT currently has checked out. We must NOT auto-checkout the parent branch — the
    // repo root is the LIVE deployment-source checkout and switching its branch can
    // crash-loop the backend. Instead, GUARD: only merge if the root is already on the
    // parent branch; otherwise fail clearly without merging.
    const st = await this.d.repoOp('status', row.repoPath)
    const current = this.parseCurrentBranch(st.output)
    if (current !== row.parentBranch) {
      return {
        ok: false,
        output: `repo root at ${row.repoPath} is on '${current}', not the parent branch '${row.parentBranch}'. Check out ${row.parentBranch} there before merging.`,
        issue: this.toWire(row),
      }
    }
    const r = await this.d.repoOp('mergeFfOnly', row.repoPath, { branch: row.branch })
    if (r.ok) {
      return { ...r, issue: this.close(id, 'done') }
    }
    return { ...r, issue: this.toWire(row) }
  }

  /**
   * Free an issue's working copy while KEEPING its branch [spec:SP-9904].
   * Used by session/issue stop so a finished agent can release the worktree
   * without discarding reversible work on the branch. Does NOT require the
   * issue to be closed (unlike cleanup). Caller is responsible for the
   * unsaved-work guard (dirty tree without --force) and for ensuring no live
   * sessions still use this worktree.
   */
  async freeWorktreeKeepBranch(
    id: string,
    opts?: { force?: boolean },
  ): Promise<{ ok: boolean; output: string; issue: IssueWire; worktreeFreed: boolean }> {
    const row = this.rowOrThrow(id)
    const refuse = (
      output: string,
    ): { ok: boolean; output: string; issue: IssueWire; worktreeFreed: boolean } => ({
      ok: false,
      output,
      issue: this.toWire(row),
      worktreeFreed: false,
    })
    if (!row.worktreePath) {
      return {
        ok: true,
        output: row.branch
          ? `no worktree on disk; branch '${row.branch}' kept`
          : 'no worktree/branch recorded',
        issue: this.toWire(row),
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
    const st = await this.d.repoOp('status', worktreePath, undefined, machineId)
    // Already gone on disk — clear the path of record, keep the branch.
    if (!st.ok && /cannot change to .*: no such file or directory/i.test(st.output)) {
      row.worktreePath = null
      this.persistRow(row)
      this.d.onWorktreesChanged?.(row.repoPath, machineId)
      return {
        ok: true,
        output: `worktree already gone at ${worktreePath}; branch '${branch}' kept`,
        issue: this.toWire(row),
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
    const wr = await this.d.repoOp(
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
    this.persistRow(row)
    this.d.onWorktreesChanged?.(row.repoPath, machineId)
    const issue = this.addComment(
      row.id,
      'system:stop',
      `stop: freed worktree ${worktreePath}; branch '${branch}' kept for resume/inspect`,
    )
    this.emitEvent('issue.worktree_freed', row.id, {
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
   * Ensure the issue's worktree exists on disk for the preserved branch
   * [spec:SP-9904]. Used on resume after stop freed the working copy.
   * Idempotent when the worktree is already present.
   */
  async ensureWorktree(
    id: string,
  ): Promise<{ ok: boolean; output: string; worktreePath: string | null; issue: IssueWire }> {
    const row = this.rowOrThrow(id)
    const machineId = row.machineId ?? undefined
    if (row.worktreePath) {
      const st = await this.d.repoOp('status', row.worktreePath, undefined, machineId)
      if (st.ok) {
        return {
          ok: true,
          output: 'worktree already present',
          worktreePath: row.worktreePath,
          issue: this.toWire(row),
        }
      }
      // Path recorded but missing — fall through to recreate at the same path
      // when possible, else the canonical path for the branch.
      if (!/cannot change to .*: no such file or directory/i.test(st.output)) {
        return {
          ok: false,
          output: `cannot inspect worktree: ${st.output}`,
          worktreePath: row.worktreePath,
          issue: this.toWire(row),
        }
      }
    }
    if (!row.branch) {
      return {
        ok: false,
        output: 'no branch recorded — cannot recreate worktree',
        worktreePath: null,
        issue: this.toWire(row),
      }
    }
    const path = row.worktreePath ?? this.worktreePathFor(row.repoPath, row.branch)
    if (row.machineId) this.d.requireMachineForRepo?.(row.machineId, row.repoPath)
    const res = await this.d.repoOp(
      'worktreeAddExisting',
      row.repoPath,
      { path, branch: row.branch },
      machineId,
    )
    if (!res.ok) {
      return {
        ok: false,
        output: `worktree recreate failed: ${res.output}`,
        worktreePath: null,
        issue: this.toWire(row),
      }
    }
    row.worktreePath = path
    this.persistRow(row)
    this.d.onWorktreesChanged?.(row.repoPath, row.machineId ?? undefined)
    return {
      ok: true,
      output: `recreated worktree ${path} from branch '${row.branch}'`,
      worktreePath: path,
      issue: this.toWire(row),
    }
  }

  /**
   * Guarded worktree+branch cleanup for a merged, closed issue (issue #71).
   * Every guard refuses with {ok:false, output:<reason>} and NO side effects;
   * the destructive ops themselves are non-forcing (`git worktree remove` /
   * `git branch -d` — never --force / -D), so git itself is the last guard.
   * Never touches the repo ROOT checkout: worktreeRemove/branchDelete run
   * with the root as cwd but only ever name the issue's worktree/branch.
   */
  async cleanup(id: string): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const row = this.rowOrThrow(id)
    const refuse = (output: string): { ok: boolean; output: string; issue: IssueWire } => ({
      ok: false,
      output,
      issue: this.toWire(row),
    })
    // (a) only closed issues are cleanable.
    if (!this.isClosed(row)) {
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
      const merged = await this.d.repoOp('isMergedInto', row.repoPath, {
        branch,
        parentBranch: row.parentBranch,
      })
      if (!merged.ok) {
        return refuse(
          `refusing cleanup: branch '${branch}' is not fully merged into '${row.parentBranch}'${merged.output ? ` (${merged.output})` : ''}`,
        )
      }
      const bd = await this.d.repoOp('branchDelete', row.repoPath, { branch })
      if (!bd.ok) return refuse(this.branchDeleteRefusal(branch, row.parentBranch, bd.output))
      row.branch = null
      this.persistRow(row)
      const issue = this.addComment(
        row.id,
        'system:cleanup',
        `cleanup: deleted merged branch '${branch}' (worktree was already removed)`,
      )
      this.emitEvent('issue.cleaned', row.id, { seq: row.seq, worktreePath: null, branch })
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
    const st = await this.d.repoOp('status', worktreePath)
    if (!st.ok && /cannot change to .*: no such file or directory/i.test(st.output)) {
      row.worktreePath = null
      row.branch = null
      this.persistRow(row)
      const issue = this.addComment(
        row.id,
        'system:cleanup',
        `cleanup: worktree ${worktreePath} already gone; cleared recorded worktree/branch (${branch})`,
      )
      this.emitEvent('issue.cleaned', row.id, {
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
    const merged = await this.d.repoOp('isMergedInto', row.repoPath, {
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
    const wr = await this.d.repoOp('worktreeRemove', row.repoPath, { path: worktreePath })
    if (!wr.ok) return refuse(`worktree remove failed: ${wr.output}`)
    row.worktreePath = null
    this.persistRow(row) // columns reflect reality even if branch delete refuses below
    // Delete the branch (-d only; git refuses unmerged as a belt-and-braces guard).
    const bd = await this.d.repoOp('branchDelete', row.repoPath, { branch })
    if (!bd.ok) {
      const why = this.branchDeleteRefusal(branch, row.parentBranch, bd.output)
      const issue = this.addComment(
        row.id,
        'system:cleanup',
        `cleanup: removed worktree ${worktreePath}; branch '${branch}' NOT deleted: ${why}`,
      )
      return {
        ok: false,
        output: `worktree ${worktreePath} removed, but branch delete refused: ${why}`,
        issue,
      }
    }
    row.branch = null
    this.persistRow(row)
    const issue = this.addComment(
      row.id,
      'system:cleanup',
      `cleanup: removed worktree ${worktreePath} and deleted merged branch '${branch}'`,
    )
    this.emitEvent('issue.cleaned', row.id, { seq: row.seq, worktreePath, branch })
    return { ok: true, output: `removed ${worktreePath}; deleted branch ${branch}`, issue }
  }

  /**
   * Rebuild an epic's integration branch from its closed children (issue #70).
   *
   * REBUILD semantics: every run resets `integrate/<seq>-<slug>` (in worktree
   * `<repo>/.worktrees/integrate-<seq>-<slug>`) to the epic's parentBranch tip and
   * replays every closed child branch in topological order over the children's
   * blocks-deps (tie-break by seq) — idempotent, no drift. Per child: ff-merge onto
   * the integration head; if not ff, rebase a TEMP copy (`integrate-tmp/<childSeq>`,
   * never the child's own branch) and ff-merge that. On conflict: abort the rebase,
   * leave the integration branch at the last good state, flag the epic needs_human,
   * and stop — no further children attempted, no conflict markers ever committed.
   *
   * NEVER touches the repo ROOT checkout: all mutating git ops run inside the
   * integration worktree (worktreeAddReset runs from the root cwd but only writes
   * the new worktree dir + the integrate/ ref). Promotion to parentBranch stays
   * with the gated merge flow — integrate does NOT merge to main.
   *
   * Audit: ONE summary comment per run (skipped when byte-identical to the previous
   * integrate comment — rebuild-every-run makes per-child "Integrated #N" markers
   * meaningless across resets, so run-summary-only is the correct dedup unit), plus
   * an issue.integration event {epicSeq, integrated, blockedAt?} per run.
   */
  async integrate(id: string): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const row = this.rowOrThrow(id)
    // Per-epic in-flight guard: two overlapping runs would interleave resets/rebases
    // in the SAME integration worktree. Re-entry refuses cleanly with zero repoOps.
    if (this.integratingEpics.has(row.id)) {
      return {
        ok: false,
        output: `integration already running for #${row.seq}`,
        issue: this.toWire(row),
      }
    }
    this.integratingEpics.add(row.id)
    try {
      return await this.integrateRun(row)
    } finally {
      this.integratingEpics.delete(row.id)
    }
  }

  private readonly integratingEpics = new Set<string>()

  private async integrateRun(
    row: IssueRow,
  ): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const refuse = (output: string): { ok: boolean; output: string; issue: IssueWire } => ({
      ok: false,
      output,
      issue: this.toWire(row),
    })
    // Preconditions: the target must have children, ≥1 of them closed with a branch.
    const children = [...this.rows.values()].filter((r) => r.parentId === row.id)
    if (children.length === 0) {
      return refuse(`refusing integrate: #${row.seq} has no children`)
    }
    const closed = children.filter(
      (c): c is IssueRow & { branch: string } => this.isClosed(c) && !!c.branch,
    )
    if (closed.length === 0) {
      return refuse(
        `refusing integrate: no closed child of #${row.seq} has a recorded branch (close ≥1 started child first)`,
      )
    }
    const ordered = this.topoOrderChildren(closed)
    // Branch/worktree names share the `<seq>-<slug>` stem with issue branches.
    const stem = this.slug(row.seq, row.title).replace(/^issue\//, '')
    const intBranch = `integrate/${stem}`
    const worktree = `${row.repoPath}/.worktrees/integrate-${stem}`
    // Reset-or-create the integration worktree at the parentBranch tip.
    const st = await this.d.repoOp('status', worktree)
    if (!st.ok && /cannot change to .*: no such file or directory/i.test(st.output)) {
      const add = await this.d.repoOp('worktreeAddReset', row.repoPath, {
        path: worktree,
        branch: intBranch,
        startPoint: row.parentBranch,
      })
      if (!add.ok) return refuse(`integrate: worktree add failed: ${add.output}`)
    } else if (!st.ok) {
      return refuse(`integrate: cannot inspect integration worktree: ${st.output}`)
    } else {
      // Self-healing: if a previous run's conflict recovery itself failed (its
      // rebaseAbort errored), the worktree is stuck mid-rebase and checkoutReset
      // would refuse with a raw git error. A defensive abort first (result ignored
      // — "no rebase in progress" is the normal healthy outcome) un-wedges it.
      await this.d.repoOp('rebaseAbort', worktree)
      const reset = await this.d.repoOp('checkoutReset', worktree, {
        branch: intBranch,
        startPoint: row.parentBranch,
      })
      if (!reset.ok) return refuse(`integrate: branch reset failed: ${reset.output}`)
    }
    // Replay children in order; stop at the first conflict/failure.
    const integrated: number[] = []
    let blockedAt: number | undefined
    let blockedWhy = ''
    for (const child of ordered) {
      const ff = await this.d.repoOp('mergeFfOnly', worktree, { branch: child.branch })
      if (ff.ok) {
        integrated.push(child.seq)
        continue
      }
      // Not ff: rebase a TEMP copy of the child branch onto the integration head.
      const temp = `integrate-tmp/${child.seq}`
      const co = await this.d.repoOp('checkoutReset', worktree, {
        branch: temp,
        startPoint: child.branch,
      })
      if (!co.ok) {
        blockedAt = child.seq
        blockedWhy = this.gitSummary(co.output)
        break
      }
      const rb = await this.d.repoOp('rebase', worktree, { parentBranch: intBranch })
      if (!rb.ok) {
        // Conflict: abort cleanly, return to the last good integration head, drop
        // the temp ref. Never commits conflict markers (rebase stopped mid-way).
        await this.d.repoOp('rebaseAbort', worktree)
        await this.d.repoOp('checkout', worktree, { branch: intBranch })
        await this.d.repoOp('branchDeleteForce', worktree, { branch: temp })
        blockedAt = child.seq
        blockedWhy = this.gitSummary(rb.output)
        break
      }
      await this.d.repoOp('checkout', worktree, { branch: intBranch })
      const mg = await this.d.repoOp('mergeFfOnly', worktree, { branch: temp })
      await this.d.repoOp('branchDeleteForce', worktree, { branch: temp })
      if (!mg.ok) {
        blockedAt = child.seq
        blockedWhy = this.gitSummary(mg.output)
        break
      }
      integrated.push(child.seq)
    }
    const landed = integrated.length ? integrated.map((s) => `#${s}`).join(', ') : '(none)'
    const summary =
      blockedAt == null
        ? `integrate: rebuilt '${intBranch}' from '${row.parentBranch}'; integrated ${landed}`
        : `integrate: rebuilt '${intBranch}' from '${row.parentBranch}'; integrated ${landed}; integration blocked at #${blockedAt}: ${blockedWhy}`
    // Comment dedup: rebuild runs are idempotent, so an unchanged outcome must not
    // spam a new comment — skip when the latest integrate comment is identical.
    const prior = this.d.store.issues
      .listIssueComments(row.id)
      .filter((c) => c.author === 'system:integrate')
      .at(-1)
    if (prior?.body !== summary) this.addComment(row.id, 'system:integrate', summary)
    if (blockedAt != null) {
      this.setNeedsHuman(row.id, `integration blocked at #${blockedAt}: ${blockedWhy}`)
    }
    this.emitEvent('issue.integration', row.id, {
      epicSeq: row.seq,
      integrated,
      ...(blockedAt != null ? { blockedAt } : {}),
    })
    return { ok: blockedAt == null, output: summary, issue: this.toWire(row) }
  }

  /** Topological order over blocks-deps AMONG the given children (a dep on an issue
   *  outside the set is ignored), ties broken by seq. `X blocks-dep→ Y` means X is
   *  blocked by Y, so Y integrates first. Kahn's algorithm; any leftover (cycle —
   *  addDep prevents them, defensive only) appends in seq order. */
  private topoOrderChildren<T extends IssueRow>(children: T[]): T[] {
    const inSet = new Map(children.map((c) => [c.id, c]))
    const indeg = new Map(children.map((c) => [c.id, 0]))
    const dependents = new Map<string, string[]>() // blocker id -> ids it unblocks
    for (const c of children) {
      for (const d of this.d.store.issues.listIssueDeps(c.id)) {
        if (d.type !== 'blocks' || !inSet.has(d.toId)) continue
        indeg.set(c.id, (indeg.get(c.id) ?? 0) + 1)
        dependents.set(d.toId, [...(dependents.get(d.toId) ?? []), c.id])
      }
    }
    const bySeq = (a: T, b: T): number => a.seq - b.seq
    const ready = children.filter((c) => indeg.get(c.id) === 0).sort(bySeq)
    const out: T[] = []
    while (ready.length) {
      const next = ready.shift() as T
      out.push(next)
      for (const depId of dependents.get(next.id) ?? []) {
        const left = (indeg.get(depId) ?? 0) - 1
        indeg.set(depId, left)
        if (left === 0) {
          ready.push(inSet.get(depId) as T)
          ready.sort(bySeq)
        }
      }
    }
    for (const c of children.sort(bySeq)) if (!out.includes(c)) out.push(c)
    return out
  }

  /** First non-empty line of a git failure, for comments/needs_human questions. */
  private gitSummary(output: string): string {
    const line = output.split('\n').find((l) => l.trim() !== '')
    return (line ?? 'git operation failed').trim().slice(0, 200)
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

  addSession(
    id: string,
    agentKind?: string,
    opts?: { spawnedBy?: string; forceUnknownModel?: boolean },
  ): IssueWire {
    const row = this.rowOrThrow(id)
    if (!row.worktreePath) throw new Error('issue not started')
    const kind = agentKind ?? row.defaultAgent
    const selection = this.modelSelectionFor(row, kind)
    // Reject an unavailable model/effort before spawning [spec:SP-cc60]. A 'shell'
    // session carries no model (addShell), so validation is a no-op there.
    assertModelSelectionValid(this.d.store.settings.getModelCatalog(), {
      agentKind: kind,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.effort ? { effort: selection.effort } : {}),
      ...(opts?.forceUnknownModel ? { force: true } : {}),
    })
    if (row.machineId) this.d.requireMachineForRepo?.(row.machineId, row.repoPath)
    this.d.spawnSession({
      cwd: row.worktreePath,
      issueId: row.id,
      agentKind: kind,
      model: selection.model,
      effort: selection.effort,
      ...(opts?.forceUnknownModel ? { forceUnknownModel: true } : {}),
      spawnedBy: opts?.spawnedBy ?? `issue:${row.id}`,
      ...(row.machineId ? { machineId: row.machineId } : {}),
    })
    return this.toWire(row)
  }
  addShell(id: string, opts?: { spawnedBy?: string }): IssueWire {
    return this.addSession(id, 'shell', opts)
  }

  async linearSearch(query: string): Promise<LinearIssue[]> {
    const key = this.d.getSettings().integrations?.linearApiKey
    if (!key) return []
    const search = this.d.linearSearch ?? searchIssues
    return search(key, query)
  }

  /** A member session just ENTERED an attention phase — a new message needs the
   *  user. End any "until next message" defer on the issue(s) owning the session
   *  so they resurface exactly when there's something new (the issue mirror of a
   *  session's `snoozedUntil: null` snooze). */
  onSessionAttention(sessionId: string): void {
    const sess = this.d.listSessions().find((s) => s.sessionId === sessionId)
    if (!sess) return
    for (const row of [...this.rows.values()]) {
      if (row.deferUntil !== DEFER_NEXT_MESSAGE || row.deletedAt) continue
      if (sessionsForIssue(row.worktreePath, [sess], row.id).length > 0) this.defer(row.id, null)
    }
  }

  private assistantTimers = new Map<string, ReturnType<typeof setTimeout>>()

  onSessionActivity(sessionId: string): void {
    if (!this.d.getSettings().issues?.assistantEnabled) return
    const sess = this.d.listSessions().find((s) => s.sessionId === sessionId)
    if (!sess) return
    const row = [...this.rows.values()].find(
      (r) =>
        r.worktreePath &&
        (sess.cwd === r.worktreePath || sess.cwd.startsWith(`${r.worktreePath}/`)),
    )
    if (!row) return
    const prev = this.assistantTimers.get(row.id)
    if (prev) clearTimeout(prev)
    this.assistantTimers.set(
      row.id,
      setTimeout(() => {
        this.assistantTimers.delete(row.id)
        void this.refreshAssistant(row.id).catch(() => {})
      }, 120_000),
    )
  }

  async refreshAssistant(id: string): Promise<IssueWire> {
    const row = this.rowOrThrow(id)
    if (!row.worktreePath) return this.toWire(row)
    const settings = this.d.getSettings()
    const members = sessionsForIssue(row.worktreePath, this.d.listSessions(), row.id).map((s) => ({
      agentKind: s.agentKind,
      phase: s.agentState?.phase ?? 'shell',
      tail: '',
    }))
    const [status, log] = await Promise.all([
      this.d.repoOp('status', row.worktreePath).catch(() => ({ ok: false, output: '' })),
      this.d.repoOp('log', row.worktreePath).catch(() => ({ ok: false, output: '' })),
    ])
    const others = [...this.rows.values()]
      .filter(
        (r) => r.id !== row.id && this.inRepoScope(r, row.repoPath) && !r.archived && !r.deletedAt,
      )
      .map((r) => ({ seq: r.seq, title: r.title, stage: r.stage, branch: r.branch }))
    const ctx = {
      issue: {
        title: row.title,
        description: row.description,
        stage: row.stage,
        branch: row.branch,
        ...(row.prUrl ? { prUrl: row.prUrl } : {}),
      },
      gitStatus: status.output,
      gitLog: log.output,
      members,
      otherIssues: others,
    }
    let result = null as ReturnType<typeof parseAssistantJson>
    try {
      // The shared one-shot primitive (SP-6454): resolves the 'background' role's
      // backend + account, runs one completion, parses into structured data.
      const resp = await completeForRole(
        { settings, llm: this.d.llm },
        { role: 'background', messages: buildAssistantMessages(ctx), parse: parseAssistantJson },
      )
      result = resp.data
    } catch {
      result = null
    }
    if (!result) return this.toWire(row) // leave prior state intact on any LLM/parse failure
    row.activityNotes = result.activityNotes || row.activityNotes
    row.notesUpdatedAt = this.now()
    row.blockedBy = result.blockedBy
    row.dependencyNote = result.dependencyNote || null
    // Trust the model's stage when valid and different from current; else clear the suggestion.
    const digestStage = result.suggestedStage
    row.suggestedStage = digestStage && digestStage !== row.stage ? digestStage : null
    row.suggestedReason = row.suggestedStage ? result.suggestedReason : null
    return this.persistRow(row)
  }
}
