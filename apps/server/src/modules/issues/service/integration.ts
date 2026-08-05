import type { IssueId, IssueWire } from '@podium/model'
import type { CommandPrincipal } from '../../../command-principal'
import type { IssueRow } from '../../../store'
import type { IssueAttentionModule } from './attention'
import type { IssueStore } from './core'
import type { IssueCommentsMailModule } from './mail'

/**
 * EPIC INTEGRATION — the second job the git-workflow capability was still doing.
 *
 * `IssueGitWorkflowModule` owns ONE issue's git life: its branch and worktree from
 * start to cleanup, and the per-session projection ("has this task committed, is it
 * merged?") that its debounce coalesces and publishes. This module owns something
 * else: rebuilding an EPIC's integration branch by replaying its closed children,
 * which is a batch over other issues' branches into a branch and worktree the epic
 * does not own and no session ever runs in.
 *
 * POD-417 cut here for the reason POD-1606 cut the activity digest out. The
 * cohesive-owner argument this family is held to asks which fields a split would
 * force two owners to SHARE — and `integratingEpics` was never one of them. It is
 * the in-flight guard for this run and nothing else reads it; the four fields that
 * stayed behind (`gitRefreshes`, `gitCommitsBySession`, `gitTouchedBySession`,
 * `parentTips`) are the git projection, and no line below touches any of them.
 * The two jobs shared an owner because both spend `repoOp` calls, which is a
 * dependency in common, not state.
 *
 * Its ports are the ones the run actually needs: {@link IssueStore} — the single
 * store POD-320's capabilities compose over — plus the comment writer for its audit
 * summary and the attention setter for a blocked rebuild. `workflow.ts` keeps a
 * one-line delegate so the registry, the capability interface and every existing
 * test call the same method on the same object.
 */
export class IssueEpicIntegrationModule {
  /** Per-epic in-flight guard. Two overlapping runs would interleave resets and
   *  rebases in the SAME integration worktree, so a run holds its epic's id for
   *  its duration and a concurrent second call refuses without spending a repoOp. */
  private readonly integratingEpics = new Set<string>()

  constructor(
    private readonly store: IssueStore,
    private readonly commentsMail: () => Pick<IssueCommentsMailModule, 'addComment'>,
    private readonly attention: () => Pick<IssueAttentionModule, 'setNeedsHuman'>,
  ) {}

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
   *
   * `principal` is who asked for the integrate (POD-1344). Author stays
   * `system:integrate` (job label / dedup key); actor/onBehalfOf name the caller.
   */
  async integrate(
    id: string,
    principal: CommandPrincipal,
  ): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const row = this.store.rowOrThrow(id)
    // Per-epic in-flight guard: two overlapping runs would interleave resets/rebases
    // in the SAME integration worktree. Re-entry refuses cleanly with zero repoOps.
    if (this.integratingEpics.has(row.id)) {
      return {
        ok: false,
        output: `integration already running for #${row.seq}`,
        issue: this.store.toWire(row),
      }
    }
    this.integratingEpics.add(row.id)
    try {
      return await this.integrateRun(row, principal)
    } finally {
      this.integratingEpics.delete(row.id)
    }
  }

  private async integrateRun(
    row: IssueRow,
    principal: CommandPrincipal,
  ): Promise<{ ok: boolean; output: string; issue: IssueWire }> {
    const refuse = (output: string): { ok: boolean; output: string; issue: IssueWire } => ({
      ok: false,
      output,
      issue: this.store.toWire(row),
    })
    // Preconditions: the target must have children, ≥1 of them closed with a branch.
    const children = [...this.store.rows.values()].filter((r) => r.parentId === row.id)
    if (children.length === 0) {
      return refuse(`refusing integrate: #${row.seq} has no children`)
    }
    const closed = children.filter(
      (c): c is IssueRow & { branch: string } => this.store.isClosed(c) && !!c.branch,
    )
    if (closed.length === 0) {
      return refuse(
        `refusing integrate: no closed child of #${row.seq} has a recorded branch (close ≥1 started child first)`,
      )
    }
    const ordered = this.topoOrderChildren(closed)
    // Branch/worktree names share the `<seq>-<slug>` stem with issue branches.
    const stem = this.store.slug(row.seq, row.title).replace(/^issue\//, '')
    const intBranch = `integrate/${stem}`
    const worktree = `${row.repoPath}/.worktrees/integrate-${stem}`
    // Reset-or-create the integration worktree at the parentBranch tip.
    const st = await this.store.d.repoOp('status', worktree)
    if (!st.ok && /cannot change to .*: no such file or directory/i.test(st.output)) {
      const add = await this.store.d.repoOp('worktreeAddReset', row.repoPath, {
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
      await this.store.d.repoOp('rebaseAbort', worktree)
      const reset = await this.store.d.repoOp('checkoutReset', worktree, {
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
      const ff = await this.store.d.repoOp('mergeFfOnly', worktree, { branch: child.branch })
      if (ff.ok) {
        integrated.push(child.seq)
        continue
      }
      // Not ff: rebase a TEMP copy of the child branch onto the integration head.
      const temp = `integrate-tmp/${child.seq}`
      const co = await this.store.d.repoOp('checkoutReset', worktree, {
        branch: temp,
        startPoint: child.branch,
      })
      if (!co.ok) {
        blockedAt = child.seq
        blockedWhy = this.gitSummary(co.output)
        break
      }
      const rb = await this.store.d.repoOp('rebase', worktree, { parentBranch: intBranch })
      if (!rb.ok) {
        // Conflict: abort cleanly, return to the last good integration head, drop
        // the temp ref. Never commits conflict markers (rebase stopped mid-way).
        await this.store.d.repoOp('rebaseAbort', worktree)
        await this.store.d.repoOp('checkout', worktree, { branch: intBranch })
        await this.store.d.repoOp('branchDeleteForce', worktree, { branch: temp })
        blockedAt = child.seq
        blockedWhy = this.gitSummary(rb.output)
        break
      }
      await this.store.d.repoOp('checkout', worktree, { branch: intBranch })
      const mg = await this.store.d.repoOp('mergeFfOnly', worktree, { branch: temp })
      await this.store.d.repoOp('branchDeleteForce', worktree, { branch: temp })
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
    const prior = this.store.d.store.issues
      .listIssueComments(row.id)
      .filter((c) => c.author === 'system:integrate')
      .at(-1)
    if (prior?.body !== summary)
      this.commentsMail().addComment(row.id, 'system:integrate', summary, principal)
    if (blockedAt != null) {
      this.attention().setNeedsHuman(row.id, `integration blocked at #${blockedAt}: ${blockedWhy}`)
    }
    this.store.emitEvent('issue.integration', row.id, {
      epicSeq: row.seq,
      integrated,
      ...(blockedAt != null ? { blockedAt } : {}),
    })
    return { ok: blockedAt == null, output: summary, issue: this.store.toWire(row) }
  }

  /** Topological order over blocks-deps AMONG the given children (a dep on an issue
   *  outside the set is ignored), ties broken by seq. `X blocks-dep→ Y` means X is
   *  blocked by Y, so Y integrates first. Kahn's algorithm; any leftover (cycle —
   *  addDep prevents them, defensive only) appends in seq order. */
  private topoOrderChildren<T extends IssueRow>(children: T[]): T[] {
    const inSet = new Map(children.map((c) => [c.id, c]))
    const indeg = new Map(children.map((c) => [c.id, 0]))
    const dependents = new Map<IssueId, IssueId[]>() // blocker id -> ids it unblocks
    for (const c of children) {
      for (const d of this.store.d.store.issues.listIssueDeps(c.id)) {
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
}
