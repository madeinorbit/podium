/**
 * Pure machine-affinity and handoff target selection — the PER-MACHINE
 * AVAILABILITY PROJECTION, and the other half of the POD-303 split.
 *
 * `AgentManifest` (@podium/harness) is the STATIC declaration: in-repo code keyed
 * by `BuiltinHarnessKind`, identical for every tenant, principal-free, and
 * totality-checked by the compiler. Everything in THIS file answers a different
 * question — "can *this* harness run on *that* machine, for *this* principal,
 * right now?" — and that is a per-machine fact. Per
 * `docs/multi-user-readiness.md` §3.1.1/§3.1.4 and ADR 1 Amendment 1 D13.5, every
 * fact about a machine is **owned compute**: it INHERITS its machine's scoping
 * (owner-private, grantable per `see` / `use` / `manage`) rather than carrying its
 * own owner or visibility class, and it is explicitly NOT tenant-visible
 * infrastructure. The functions here therefore take the machine (and, from Phase
 * 4, its `use` decision) as INPUT and stay pure; they never resolve a principal,
 * and no type in this file grows an owner field.
 */
import { worktreeForCwd, worktreeSubpath } from '../identity/worktree'

export interface RepoMachines {
  machines?: { machineId: string; path: string }[]
  /** A fresh machine can materialize this repository when an origin is known. */
  originUrl?: string | null
}

export interface SelectableMachine {
  id: string
  online: boolean
}
export interface RecentSession {
  machineId?: string
  createdAt: string
}

/** Machines that have this repo, regardless of online status. */
export function machinesWithRepo<M extends SelectableMachine>(
  repo: RepoMachines,
  machines: M[],
): M[] {
  const repoMachineIds = new Set((repo.machines ?? []).map((m) => m.machineId))
  return machines.filter((m) => repoMachineIds.has(m.id))
}

/** Online machines that have this repo. */
export function machinesForRepo<M extends SelectableMachine>(
  repo: RepoMachines,
  machines: M[],
): M[] {
  return machinesWithRepo(repo, machines).filter((m) => m.online)
}

/** Machines that either have this repo already or can clone it from its origin. */
export function machinesForRepoOrClone<M extends SelectableMachine>(
  repo: RepoMachines,
  machines: M[],
): M[] {
  return repo.originUrl ? machines : machinesWithRepo(repo, machines)
}

/** Online machines that have this repo or can clone it on first use. */
export function onlineMachinesForRepoOrClone<M extends SelectableMachine>(
  repo: RepoMachines,
  machines: M[],
): M[] {
  return machinesForRepoOrClone(repo, machines).filter((machine) => machine.online)
}

export interface HandoffSession {
  cwd: string
  machineId?: string
  agentKind: string
}
/** The issue a session is attached to — its branch and workspace ([spec:SP-4ef9]). */
export interface HandoffIssue {
  branch?: string | null
  worktreePath?: string | null
}
export type HandoffWorktree = { path: string; isMain: boolean; machineId?: string }
export interface HandoffRepo extends RepoMachines {
  repoId?: string
  originUrl?: string
  worktrees: HandoffWorktree[]
}
/**
 * One principal's `use` verdict on one machine (readiness §3.1.4 M1: `use` =
 * spawn, reattach, attach a PTY, run harness commands, read/write files, take a
 * worktree). Owner-only until explicitly granted; POD-1079 resolves it.
 *
 * There is no `'unknown'` member ON PURPOSE. A third state would be read at every
 * call site as "probably fine" and the gate would fail OPEN. The un-evaluated case
 * is instead the ABSENCE of the field (see {@link HandoffMachine.use}), which is
 * visible in a diff and greppable, whereas a permissive enum member is neither.
 */
export type MachineUseDecision = 'granted' | 'denied'

export interface HandoffMachine extends SelectableMachine {
  inventory?: {
    agents: { kind: string; installed: boolean; login: { state: 'in' | 'out' | 'unknown' } }[]
  }
  /**
   * The calling principal's `use` decision for this machine, when someone has
   * resolved it. ABSENT means NOT EVALUATED — today's single-operator world, where
   * one `OPERATOR` owns every machine and there is no grant to consult. It does
   * NOT mean granted, and a caller must not synthesize `'granted'` to silence a
   * type error; that is how a permission check becomes decorative.
   *
   * Phase 4 (POD-1079) supplies this at the server projection boundary, which is
   * where the principal lives — this package stays principal-free (readiness
   * §3.1.6 S5: the daemon-side layers run as a system principal that may read
   * across owners but never acts as a person).
   */
  use?: MachineUseDecision
}

/**
 * Why one machine cannot run a requested agent right now.
 *
 * UNREACHABLE AND UNAUTHORIZED ARE DIFFERENT ANSWERS, and this union is where that
 * distinction is kept. Readiness §3.1.4 M5 is explicit: spawn UI must not offer
 * machines the principal lacks `use` on, *and* "an unreachable-vs-unauthorized
 * distinction must be visible, since 'denied' and 'offline' produce the same empty
 * list otherwise". Those two failures need opposite responses from a user — wake
 * the machine up, versus ask its owner for access — so a projection that
 * flattens them to "not available" is lying by omission.
 *
 *  - `unauthorized` — we KNOW, and the answer is no: the principal has no `use`
 *    grant on this machine. Not a temporary condition and not fixable by waiting.
 *  - `offline` — we DON'T know: the daemon is unreachable, so nothing about the
 *    harness there is currently knowable. `harness-missing` and `logged-out` are
 *    PROBED facts and therefore only meaningful while reachable.
 *  - `harness-missing` — reachable, and this harness is not installed there. Also
 *    the answer for a `HarnessId` this build has never heard of: an unknown
 *    harness is simply absent from the machine's inventory, which degrades to
 *    "cannot run it here" rather than throwing or guessing another CLI.
 *  - `logged-out` — reachable and installed, but the CLI has no credentials.
 */
export type AgentCapabilityRejection =
  | 'unauthorized'
  | 'offline'
  | 'harness-missing'
  | 'logged-out'

/**
 * One authoritative capability rule for new sessions and handoff. Shells need
 * only an online daemon; harnesses must be installed and must not be explicitly
 * logged out. An unknown login state remains usable (some adapters cannot prove
 * login without actually starting the CLI).
 *
 * `agentKind` is an OPEN identifier (a `HarnessId`, an `AgentKind`, or a name from
 * a newer peer) and is compared against the machine's inventory by value — never
 * dispatched through a closed `switch`. An unrecognized name therefore degrades to
 * `'harness-missing'`; it does not throw, and it does not fall through to
 * whichever harness happens to be first.
 *
 * ORDER: the `use` denial is checked FIRST, before liveness and before any
 * inventory read. Two reasons, and the fork is resolved from readiness §3.1.4
 * M2 + §3.1.5 rather than by taste. (1) Fail closed: a denied machine must not
 * answer questions about its inventory or its owner's login state — that is
 * `use`-gated detail per the `see`/`use` partition in `../entities/machine.ts`,
 * and `use` is a code-execution boundary, not a privacy toggle. (2) Consistent
 * error: §3.1.5's rule is that an unauthorized answer must not vary with the
 * hidden state, or the rejection reason becomes an oracle for it. Liveness itself
 * is inside `see`, so nothing is lost by reporting the denial instead.
 */
export function agentCapabilityRejection<M extends HandoffMachine>(
  machine: M,
  agentKind: string,
): AgentCapabilityRejection | undefined {
  if (machine.use === 'denied') return 'unauthorized'
  if (!machine.online) return 'offline'
  if (agentKind === 'shell') return undefined
  const harness = machine.inventory?.agents.find((agent) => agent.kind === agentKind)
  if (harness?.installed !== true) return 'harness-missing'
  return harness.login.state === 'out' ? 'logged-out' : undefined
}

/** Online machines that can run `agentKind` according to their latest inventory. */
export function machinesForAgent<M extends HandoffMachine>(machines: M[], agentKind: string): M[] {
  return machines.filter((machine) => agentCapabilityRejection(machine, agentKind) === undefined)
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
export function handoffAvailability<M extends HandoffMachine>(
  session: HandoffSession,
  repos: HandoffRepo[],
  machines: M[],
  issue?: HandoffIssue,
): HandoffAvailability<M> {
  if (session.agentKind !== 'claude-code' && session.agentKind !== 'codex')
    return { blocker: 'harness', candidates: [] }
  const source = handoffSource(session, repos, issue)
  if (!source) return { blocker: 'no-worktree', candidates: [] }
  if (!source.repo.repoId) return { blocker: 'repo-unregistered', candidates: [] }
  const repoMachineIds = new Set((source.repo.machines ?? []).map((entry) => entry.machineId))
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

/** The machineId of the most recently created session among the given machines. */
export function lastUsedMachine<S extends RecentSession, M extends SelectableMachine>(
  sessions: S[],
  machines: M[],
): string | undefined {
  const machineIds = new Set(machines.map((m) => m.id))
  let best: S | undefined
  for (const s of sessions) {
    if (s.machineId !== undefined && machineIds.has(s.machineId)) {
      if (best === undefined || s.createdAt > best.createdAt) best = s
    }
  }
  return best?.machineId
}

/** Recommended machine: most recently used eligible machine, then first eligible. */
export function resolveTargetMachine<S extends RecentSession, M extends SelectableMachine>(
  repo: RepoMachines,
  sessions: S[],
  machines: M[],
): string | undefined {
  const eligible = machinesForRepo(repo, machines)
  if (eligible.length === 0) return undefined
  return lastUsedMachine(sessions, eligible) ?? eligible[0]?.id
}

/** Recommended machine among hosts that have (or can clone) the repo and can run this agent. */
export function resolveTargetMachineForAgent<S extends RecentSession, M extends HandoffMachine>(
  repo: RepoMachines,
  sessions: S[],
  machines: M[],
  agentKind: string,
): string | undefined {
  const eligible = onlineMachinesForRepoOrClone(repo, machines).filter(
    (machine) => agentCapabilityRejection(machine, agentKind) === undefined,
  )
  if (eligible.length === 0) return undefined
  return lastUsedMachine(sessions, eligible) ?? eligible[0]?.id
}
