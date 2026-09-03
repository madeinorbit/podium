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
import {
  type AgentProbeError,
  type MachineComponent,
  type MachineUseDecision,
  probeTimeoutDescription,
} from '../entities/machine'
import type { MachineId } from '../ids/brands'

export interface RepoMachines {
  machines?: { machineId: MachineId; path: string }[]
  /** A fresh machine can materialize this repository when an origin is known. */
  originUrl?: string | null
}

export interface SelectableMachine {
  id: string
  online: boolean
  /**
   * The DURABLE components installed here (POD-2700). See
   * {@link MachineComponent} for what each one means, and
   * {@link structuralRejection} for why ABSENT is not the same as `[]`.
   *
   * It sits on `SelectableMachine` rather than only on the richer
   * {@link HandoffMachine} because the structural axis is the FIRST question
   * every selection helper in this file has to answer — including the plain
   * repo-affinity ones, which is exactly where the coordinator got picked.
   */
  components?: readonly MachineComponent[]
  /**
   * The calling principal's `use` decision, when someone has resolved it.
   * ABSENT means NOT EVALUATED — never "granted"; see {@link MachineUseDecision}
   * and the longer note on {@link HandoffMachine.use}, which is where it used to
   * live. It moved up here at POD-2700 because the requirement predicates below
   * must check the denial FIRST for every requirement, including the ones that
   * never touch an inventory.
   */
  use?: MachineUseDecision
}
export interface RecentSession {
  machineId?: MachineId
  createdAt: string
}

/** A machine as a human names it on a command line (POD-1386). */
export interface NameableMachine {
  id: string
  name: string
  hostname: string
}

/**
 * Resolve what a human typed — `--machine <name|id>` — to exactly one machine,
 * or to `null`.
 *
 * EXACT MATCHES ONLY, and the order is id → name → hostname so an id can never
 * be shadowed by someone else's chosen name. There is deliberately no prefix,
 * fuzzy or case-insensitive fallback: the consequence of resolving wrongly is
 * that real work starts on the wrong host, where it will look like it worked.
 * An agent that guessed a name should be told it guessed.
 *
 * It lives here, beside the other machine predicates, because BOTH command
 * surfaces need it — `podium machine show` / `podium session handoff --to` in
 * the CLI and `podium issue start --machine` in the issue client — and a second
 * copy of a matching rule is how two surfaces come to disagree about which host
 * a name means.
 *
 * PASS IT AN ALREADY-SCOPED LIST. This is a pure lookup and enforces nothing: the
 * caller supplies the machines the principal may see, so resolving against it can
 * never name a machine the caller could not otherwise name.
 */
export function machineByRef<M extends NameableMachine>(machines: M[], ref: string): M | null {
  return (
    machines.find((machine) => machine.id === ref) ??
    machines.find((machine) => machine.name === ref) ??
    machines.find((machine) => machine.hostname === ref) ??
    null
  )
}

/** Machines that have this repo, regardless of online status. */
export function machinesWithRepo<M extends SelectableMachine>(
  repo: RepoMachines,
  machines: M[],
): M[] {
  const repoMachineIds = new Set<string>((repo.machines ?? []).map((m) => m.machineId))
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
export interface HandoffMachine extends SelectableMachine {
  inventory?: {
    agents: {
      kind: string
      installed: boolean | null
      probeError?: AgentProbeError
      login: { state: 'in' | 'out' | 'unknown' }
    }[]
  }
  /**
   * INHERITED from {@link SelectableMachine} since POD-2700; the contract is
   * unchanged and its full note lives there.
   *
   * ABSENT means NOT EVALUATED — today's single-operator world, where one
   * `OPERATOR` owns every machine and there is no grant to consult. It does NOT
   * mean granted, and a caller must not synthesize `'granted'` to silence a type
   * error; that is how a permission check becomes decorative.
   *
   * Phase 4 (POD-1079) supplies this at the server projection boundary, which is
   * where the principal lives — this package stays principal-free (readiness
   * §3.1.6 S5: the daemon-side layers run as a system principal that may read
   * across owners but never acts as a person).
   */
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
 *  - `no-daemon` — STRUCTURAL, and added by POD-2700: no Podium daemon is
 *    enrolled on this machine at all, so it can never run an agent, hold a
 *    worktree or host a repo. Ordered AFTER `unauthorized` and BEFORE `offline`
 *    on purpose. After `unauthorized`, because the oracle rule below still
 *    governs: a denied machine answers `unauthorized` and nothing else. Before
 *    `offline`, because reporting a server-only coordinator as merely offline is
 *    the exact lie that pinned the repo screen to it — "bring it online" is
 *    advice that can never be taken.
 *  - `offline` — we DON'T know: the daemon is unreachable, so nothing about the
 *    harness there is currently knowable. A logged-out harness is a startable
 *    session condition, not a capability refusal.
 *  - `inventory-unavailable` — reachable, but no inventory report has arrived
 *    yet, so no install claim can be made.
 *  - `harness-probe-timed-out` — reachable and inventoried, but this harness's
 *    bounded version probe expired. Retrying may produce a definitive answer.
 *  - `harness-missing` — reachable, and this harness is not installed there. Also
 *    the answer for a `HarnessId` this build has never heard of: an unknown
 *    harness is simply absent from the machine's inventory, which degrades to
 *    "cannot run it here" rather than throwing or guessing another CLI.
 */
export type AgentCapabilityRejection =
  | 'unauthorized'
  | 'no-daemon'
  | 'offline'
  | 'inventory-unavailable'
  | 'harness-probe-timed-out'
  | 'harness-missing'

/** A condition that can be reported for a session after it starts. */
export type AgentLoginCondition = 'logged-out'

/** Rejections used while choosing an implicit target. */
export type AgentSelectionRejection = AgentCapabilityRejection | AgentLoginCondition

/**
 * One authoritative capability rule for new sessions and handoff. Shells need
 * only an online daemon; harnesses must be installed. An unknown login state
 * remains usable (some adapters cannot prove login without actually starting
 * the CLI). A known logged-out harness is startable when explicitly pinned; the
 * implicit-selection helpers below continue to avoid it when they can.
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
  const structural = structuralRejection(machine)
  if (structural !== undefined) return structural
  if (!machine.online) return 'offline'
  return harnessRejection(machine, agentKind)
}

// ---------------------------------------------------------------------------
// THE STRUCTURAL AXIS (POD-2700) — `docs/machine-capability-filtering.md` §1.
// ---------------------------------------------------------------------------

/**
 * THE STRUCTURAL DIMENSION ALONE: does this machine run a Podium daemon at all?
 *
 * Everything host-shaped — hosting a repo, holding a worktree, running an agent
 * process, opening a PTY, reporting metrics — happens THROUGH a daemon. A row
 * with no `daemon` component has no daemon to ask, now or ever, so it must never
 * be offered for any of them.
 *
 * ## Absent vs empty — the one subtlety, and it is deliberate
 *
 * `components === undefined` means NOT RECORDED and returns `undefined` (no
 * refusal); `components === []` means EVALUATED AND RUNS NOTHING and returns
 * `'no-daemon'`.
 *
 * That asymmetry is the same closed-but-not-refusing reading `use` already has
 * three functions up, and it is chosen for the same reason: the alternative
 * fails the wrong way. Reading silence as "incapable" would mean a client
 * talking to a server that predates the field sees an EMPTY picker on every
 * surface at once — the exact defect this work exists to remove, reintroduced
 * fleet-wide and blamed on capability. The server's own projection
 * (`MachinesService.listMachines`) always supplies the field, so every guard
 * that matters — the action RPCs of §2.5, which run in that same process
 * against that same projection — is armed regardless. The failure this
 * concession admits is narrow and temporary (an old *server*, not an old
 * client), and it degrades to today's behaviour rather than to a new one.
 */
export function structuralRejection<M extends SelectableMachine>(
  machine: M,
): 'no-daemon' | undefined {
  if (machine.components === undefined) return undefined
  return machine.components.includes('daemon') ? undefined : 'no-daemon'
}

/**
 * THE HARNESS DIMENSION ALONE — for callers that have already settled
 * authorization and liveness by another route.
 *
 * The client resolves `use` per-LIST rather than per-machine (a machine wire with
 * no `use` decision means NOT EVALUATED, and single-machine deployments carry
 * none), so `MachineView.availability` — not `machine.use` — is the authorization
 * reading on every spawn surface. Such a caller still needs the inventory rule,
 * and it must be the SAME rule: an agent row that greys out for a missing harness
 * in one menu and stays live in another is the drift this split exists to
 * prevent. `agentCapabilityRejection` above is this function plus the two checks
 * that precede it.
 */
export function harnessRejection<M extends HandoffMachine>(
  machine: M,
  agentKind: string,
): 'inventory-unavailable' | 'harness-probe-timed-out' | 'harness-missing' | undefined {
  if (agentKind === 'shell') return undefined
  if (!machine.inventory) return 'inventory-unavailable'
  const harness = machine.inventory.agents.find((agent) => agent.kind === agentKind)
  if (harness?.installed === null) return 'harness-probe-timed-out'
  if (harness?.installed !== true) return 'harness-missing'
  return undefined
}

/** The observed timeout attached to one harness, formatted for any refusal surface. */
export function agentProbeTimeoutDescription(
  machine: Pick<HandoffMachine, 'inventory'>,
  agentKind: string,
): string {
  const error = machine.inventory?.agents.find((agent) => agent.kind === agentKind)?.probeError
  return probeTimeoutDescription(error)
}

/** Online machines that can run `agentKind` according to their latest inventory. */
export function machinesForAgent<M extends HandoffMachine>(machines: M[], agentKind: string): M[] {
  return machines.filter(
    (machine) => agentCapabilityRejectionForSelection(machine, agentKind) === undefined,
  )
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
    (machine) => agentCapabilityRejectionForSelection(machine, agentKind) === undefined,
  )
  if (eligible.length === 0) return undefined
  return lastUsedMachine(sessions, eligible) ?? eligible[0]?.id
}

/** Rejection used by implicit placement, where a logged-out machine is skipped. */
export function agentCapabilityRejectionForSelection<M extends HandoffMachine>(
  machine: M,
  agentKind: string,
): AgentSelectionRejection | undefined {
  const rejection = agentCapabilityRejection(machine, agentKind)
  if (rejection !== undefined) return rejection
  if (agentKind === 'shell') return undefined
  const harness = machine.inventory?.agents.find((agent) => agent.kind === agentKind)
  return harness?.login.state === 'out' ? 'logged-out' : undefined
}

/** Return the login condition that a started session should expose. */
export function agentLoginCondition<M extends HandoffMachine>(
  machine: M,
  agentKind: string,
): AgentLoginCondition | undefined {
  return agentCapabilityRejectionForSelection(machine, agentKind) === 'logged-out'
    ? 'logged-out'
    : undefined
}
