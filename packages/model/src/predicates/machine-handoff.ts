/**
 * Worktree-aware handoff target selection.
 *
 * Handoff is reachable only from deferred interaction menus in the web client,
 * so keeping its path and candidate projection out of the app-shell selection
 * module preserves that existing lazy boundary.
 */
import type { z } from 'zod'
import type { IssueWorkspace } from '../fields/issue'
import { worktreeForCwd, worktreeSubpath } from '../identity/worktree'
import type { MachineId, RepoId } from '../ids/brands'
import {
  type AgentCapabilityRejection,
  agentCapabilityRejection,
  type HandoffMachine,
  type RepoMachines,
} from './machine-selection'

export interface HandoffSession {
  cwd: string
  machineId?: MachineId
  agentKind: string
}

/**
 * The issue a session is attached to — its branch and workspace ([spec:SP-4ef9]).
 * Composed from `IssueWorkspace` (POD-367, inventory #11) rather than restated:
 * both members are the issue's own workspace fields and their types have one home.
 *
 * `| null` on top of the group's types is deliberate and is why this is a mapped
 * type: a narrow structural port must be satisfiable by an `IssueRow` (storage,
 * where an unset field is `null`) as well as by an `IssueWire`.
 *
 * Both members are MACHINE facts, so this port's visibility is INHERITED from the
 * machine rather than carried here (ADR 9 D3 rule 3, owned-compute) — the same
 * note that applies to `GitProbeTarget`. Related and NOT this issue's: `use`
 * enforcement (ADR 9 D6 M5) makes `handoffTargets` below authorization-adjacent,
 * so a machine the principal cannot use must not appear in its result and one it
 * cannot SEE must be indistinguishable from one that does not exist. Flagged to
 * POD-1079/POD-323/POD-644; the predicate and its tests are untouched here.
 */
export type HandoffIssue = {
  [K in 'branch' | 'worktreePath']?: z.infer<typeof IssueWorkspace>[K] | null
}
export type HandoffWorktree = { path: string; isMain: boolean; machineId?: MachineId }
export interface HandoffRepo extends RepoMachines {
  repoId?: RepoId
  originUrl?: string
  worktrees: HandoffWorktree[]
}

export interface HandoffSourceRef<R extends HandoffRepo> {
  repo: R
  /** The worktree to move — never a main checkout ([spec:SP-3f7a]). */
  worktreePath: string
  /** Where the agent sits inside it (`''` = its root); the resumed agent lands there. */
  subpath: string
  /** Which layer resolved it: the cwd's own worktree, or the issue's. */
  via: 'cwd' | 'issue'
}

/**
 * The worktree a session would hand off, and where inside it the agent sits
 * ([spec:SP-3f7a]).
 *
 * `session.cwd` is the shell's MOMENTARY cwd — the daemon restamps it as the
 * agent moves — so requiring it to equal a worktree path is not a workable gate:
 * an agent that runs one command against the main checkout would silently lose
 * eligibility. Two layers instead:
 *   1. containment — the worktree that CONTAINS the cwd (a subdir still counts);
 *   2. issue-anchored — when the cwd has drifted onto the main checkout, the
 *      attached issue's own worktree is still this session's home, so move that.
 * A main checkout is never itself a source; git has the final say at export.
 */
export function handoffSource<R extends HandoffRepo>(
  session: HandoffSession,
  repos: R[],
  issue?: HandoffIssue,
): HandoffSourceRef<R> | null {
  const onMachine = (worktree: HandoffWorktree): boolean =>
    session.machineId === undefined || worktree.machineId === session.machineId
  // The worktree owning the cwd, across every repo. Longest match wins, so a cwd
  // under `<repo>/.worktrees/x` belongs to that worktree, not the parent checkout.
  let home: { repo: R; worktree: HandoffWorktree } | null = null
  for (const repo of repos) {
    const owned = repo.worktrees.filter(onMachine)
    const path = worktreeForCwd(
      session.cwd,
      owned.map((worktree) => worktree.path),
    )
    if (path === null || (home !== null && home.worktree.path.length >= path.length)) continue
    const worktree = owned.find((candidate) => candidate.path === path)
    if (worktree) home = { repo, worktree }
  }
  if (!home) return null
  if (!home.worktree.isMain) {
    return {
      repo: home.repo,
      worktreePath: home.worktree.path,
      subpath: worktreeSubpath(home.worktree.path, session.cwd),
      via: 'cwd',
    }
  }
  // Drifted onto the main checkout. Anchor on the issue's worktree instead — but
  // only within the repo the session is actually in, so the package's repo
  // identity still matches the tree it carries.
  //
  // The worktree alone anchors this; `issue.branch` is deliberately NOT required.
  // The handoff takes its branch from git in the worktree, never from the issue
  // row, so a null `branch` is a bookkeeping gap, not a missing workspace — and
  // on live data 19 sessions sit on issues with a worktree and no branch.
  if (issue?.worktreePath) {
    const worktree = home.repo.worktrees.find(
      (candidate) =>
        candidate.path === issue.worktreePath && !candidate.isMain && onMachine(candidate),
    )
    if (worktree) {
      return { repo: home.repo, worktreePath: worktree.path, subpath: '', via: 'issue' }
    }
  }
  return null
}

/**
 * Why a session cannot be handed off ANYWHERE — a property of the session, not of
 * any one machine, so it disables the whole menu.
 *  - `harness`: only claude-code/codex can be exported and resumed elsewhere.
 *  - `no-worktree`: neither the cwd nor the attached issue resolves to a worktree
 *    (a bare main-checkout session has no self-contained tree to move).
 *  - `repo-unregistered`: the worktree's repo has no stable cross-machine identity,
 *    so no other machine's checkout can be matched to it.
 */
export type HandoffBlocker = 'harness' | 'no-worktree' | 'repo-unregistered'
/** Why one machine cannot receive this session. */
export type HandoffRejection = AgentCapabilityRejection | 'repo-missing'
export interface HandoffCandidate<M> {
  machine: M
  /** `undefined` = eligible; otherwise why this machine is refused. */
  rejection?: HandoffRejection
}
export interface HandoffAvailability<M> {
  /** Set when nothing about the machine list matters — the session itself can't move. */
  blocker?: HandoffBlocker
  /** Every OTHER machine holding this repo, eligible or not (empty when blocked). */
  candidates: HandoffCandidate<M>[]
}

/**
 * The full handoff picture for a session: whether it can move at all, and every
 * other machine that holds its repo WITH the reason each is or isn't a valid
 * target ([spec:SP-3f7a]).
 *
 * Returns reasons rather than a filtered list because the menu states its case
 * instead of vanishing (POD-821): a silently-hidden Handoff item is
 * indistinguishable from a broken eligibility gate, which is exactly how a stale
 * repo list went unnoticed after a successful handoff.
 */
/** Data-driven picker exception: browser-safe model code cannot import the
 * node-only harness manifest, so the handoff menu carries its closed choices as data. */
const HANDOFF_CAPABLE_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'codex'])

export function handoffAvailability<M extends HandoffMachine>(
  session: HandoffSession,
  repos: HandoffRepo[],
  machines: M[],
  issue?: HandoffIssue,
): HandoffAvailability<M> {
  if (!HANDOFF_CAPABLE_HARNESSES.has(session.agentKind))
    return { blocker: 'harness', candidates: [] }
  const source = handoffSource(session, repos, issue)
  if (!source) return { blocker: 'no-worktree', candidates: [] }
  if (!source.repo.repoId) return { blocker: 'repo-unregistered', candidates: [] }
  const repoMachineIds = new Set<string>(
    (source.repo.machines ?? []).map((entry) => entry.machineId),
  )
  const candidates = machines
    .filter((machine) => machine.id !== session.machineId)
    .map((machine) => {
      const capability = agentCapabilityRejection(machine, session.agentKind)
      const rejection: HandoffRejection | undefined =
        capability ??
        (!repoMachineIds.has(machine.id) && !source.repo.originUrl ? 'repo-missing' : undefined)
      return { machine, ...(rejection ? { rejection } : {}) }
    })
  return { candidates }
}

/** Eligible move targets for a handoff-capable session ([spec:SP-3f7a]). */
export function handoffTargets<M extends HandoffMachine>(
  session: HandoffSession,
  repos: HandoffRepo[],
  machines: M[],
  issue?: HandoffIssue,
): M[] {
  return handoffAvailability(session, repos, machines, issue)
    .candidates.filter((candidate) => candidate.rejection === undefined)
    .map((candidate) => candidate.machine)
}
