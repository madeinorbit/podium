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
import type { z } from 'zod'
import type { MachineComponent, MachineUseDecision } from '../entities/machine'
import type { IssueWorkspace } from '../fields/issue'
import { worktreeForCwd, worktreeSubpath } from '../identity/worktree'
import type { MachineId, RepoId } from '../ids/brands'

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
    agents: { kind: string; installed: boolean; login: { state: 'in' | 'out' | 'unknown' } }[]
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
 *    harness there is currently knowable. `harness-missing` is a PROBED fact and
 *    therefore only meaningful while reachable. A logged-out harness is a
 *    startable session condition, not a capability refusal.
 *  - `harness-missing` — reachable, and this harness is not installed there. Also
 *    the answer for a `HarnessId` this build has never heard of: an unknown
 *    harness is simply absent from the machine's inventory, which degrades to
 *    "cannot run it here" rather than throwing or guessing another CLI.
 */
export type AgentCapabilityRejection =
  | 'unauthorized'
  | 'no-daemon'
  | 'offline'
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
 * What a caller ASKS FOR — the requirement vocabulary of §1.4.
 *
 * Surfaces state the thing the action needs rather than reading raw component
 * booleans, so that "which machines may I offer for this" is answered in ONE
 * place and two menus can never disagree about the same machine.
 *
 *  - `host-repos` — browse this machine's filesystem, scan / register / clone a
 *    repository onto it, home a worktree there.
 *  - `run-agent` — spawn or revive a session of harness `agentKind`.
 *  - `run-server` — become the coordinator.
 *
 * `manage` (rename / revoke / share / pin a channel) is DELIBERATELY NOT a
 * member. It needs no component — a fleet admin panel must show even a machine
 * that can do nothing else, or an operator can never repair it — so a
 * requirement for it would be a predicate that always answers yes, and a gate
 * that cannot say no is a gate people start trusting. Admin surfaces state no
 * requirement and list everything, which is the honest spelling.
 *
 * `receive-handoff` is likewise absent: it is `run-agent` plus a repo-presence
 * check that needs the session and its repo, so it keeps its own richer entry
 * point in {@link handoffAvailability}, which composes `run-agent` from here.
 */
export type MachineRequirement =
  | { need: 'host-repos' }
  | { need: 'run-agent'; agentKind: string }
  | { need: 'run-server' }

/** `host-repos`, spelled once so ~20 call sites do not each build the literal. */
export const HOST_REPOS: MachineRequirement = { need: 'host-repos' }
/** `run-agent(kind)`. */
export function runAgent(agentKind: string): MachineRequirement {
  return { need: 'run-agent', agentKind }
}
/** `run-server`. */
export const RUN_SERVER: MachineRequirement = { need: 'run-server' }

/** Why one machine cannot satisfy a {@link MachineRequirement} right now. */
export type MachineRejection = AgentCapabilityRejection | AgentLoginCondition | 'current-server'

/**
 * CAN THIS MACHINE EVER DO IT — the durable half, and the one that decides
 * whether a row appears in a picker AT ALL (§4.1).
 *
 * Only the two axes that never change on their own: authorization (waiting will
 * not help) and structure (no component, no capability). Liveness is excluded on
 * purpose — an offline repo host is still a repo host and must be LISTED, marked
 * offline, because "wait or wake it" is real advice. That split is the whole
 * point of the work: a disabled row says "wait", and there is nothing to wait
 * for on a machine that runs no daemon.
 */
export function structuralEligibility<M extends SelectableMachine>(
  machine: M,
  requirement: MachineRequirement,
): 'unauthorized' | 'no-daemon' | undefined {
  if (machine.use === 'denied') return 'unauthorized'
  switch (requirement.need) {
    case 'host-repos':
    case 'run-agent':
      return structuralRejection(machine)
    // `run-server` is the one requirement a daemon-less row could in principle
    // satisfy — but a transfer drives the promotion THROUGH the target's own
    // daemon, so it needs one like everything else. Stated in its own arm rather
    // than defaulted, so a future transfer that does NOT need a daemon is a
    // visible edit here instead of a silent inheritance.
    case 'run-server':
      return structuralRejection(machine)
    default: {
      // A requirement nobody taught this function must REFUSE, not fall through
      // eligible — the `requireAgent` rule, applied to the structural axis.
      const exhaustive: never = requirement
      void exhaustive
      return 'no-daemon'
    }
  }
}

/**
 * CAN THIS MACHINE DO IT RIGHT NOW — structural, then live, then detail.
 *
 * The canonical ordering of §3.2 in one place: `unauthorized` → `no-daemon` →
 * `offline` → detail. Every action RPC and every picker reads its verdict from
 * here, which is what makes the refusal a client reads and the refusal the
 * server throws the same sentence about the same machine.
 */
export function machineRejection<M extends HandoffMachine>(
  machine: M,
  requirement: MachineRequirement,
): MachineRejection | undefined {
  const structural = structuralEligibility(machine, requirement)
  if (structural !== undefined) return structural
  if (!machine.online) return 'offline'
  switch (requirement.need) {
    case 'host-repos':
      return undefined
    case 'run-agent':
      return harnessRejection(machine, requirement.agentKind)
    case 'run-server':
      return undefined
    default: {
      // A requirement nobody handled must REFUSE, not fall through eligible.
      const exhaustive: never = requirement
      void exhaustive
      return 'no-daemon'
    }
  }
}

/**
 * The words a surface needs to describe ONE requirement (POD-2700 §4.2).
 *
 * Two phrasings because the two places they land are grammatically different:
 * a headline says "No machine can host a repository yet", a footnote says
 * "1 machine can't host repositories". Passing them in keeps the copy at the
 * surface — which knows what it is asking for — while the STRUCTURE of the
 * explanation stays here, identical everywhere, so no picker can quietly ship
 * with an unexplained empty state again.
 */
export interface MachineActionCopy {
  /** Singular, after "can": "host a repository", "run this agent". */
  action: string
  /** Plural, after "can't": "host repositories", "run agents". */
  capability: string
  /** What the user could DO about it: "Pair a machine that runs the Podium daemon". */
  remedy?: string
}

const nameList = <M extends { name?: string; id: string }>(machines: readonly M[]): string =>
  machines.map((machine) => machine.name ?? machine.id).join(', ')

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/**
 * The FOOTNOTE under a picker: what was left out of the option list, and why.
 *
 * Excluded-with-a-count rather than hidden-silently, following the codebase's
 * own precedent (POD-821's handoff menu, `NewAutomationDialog`'s exclusion
 * counts): a row that vanishes is indistinguishable from a broken eligibility
 * gate. Returns `undefined` when there is genuinely nothing to explain, so a
 * healthy picker renders no chrome at all.
 */
export function machineExclusionNote<M extends HandoffMachine & { name?: string }>(
  summary: MachineChoiceSummary<M>,
  copy: MachineActionCopy,
): string | undefined {
  const parts: string[] = []
  if (summary.incapable.length > 0) {
    parts.push(
      `${plural(summary.incapable.length, 'machine', 'machines')} can't ${copy.capability} (${nameList(summary.incapable)} — runs the Podium server only)`,
    )
  }
  if (summary.awaitingFirstConnection.length > 0) {
    parts.push(
      `${plural(summary.awaitingFirstConnection.length, 'machine is', 'machines are')} waiting for a first daemon connection`,
    )
  }
  // No names and no detail: §3.2's oracle rule. A denied machine's hidden state
  // must not leak through the words used to exclude it.
  if (summary.unauthorized.length > 0) {
    parts.push(
      `${plural(summary.unauthorized.length, 'machine', 'machines')} you don't have access to`,
    )
  }
  return parts.length > 0 ? `${parts.join('; ')}.` : undefined
}

/** A picker's empty state: the headline, the axis-specific detail, the way out. */
export interface MachineEmptyState {
  title: string
  detail?: string
  remedy?: string
}

/**
 * THE EMPTY STATE, and the reason this function exists at all.
 *
 * An unexplained empty dropdown IS the reported defect. So when nothing
 * qualifies, a surface must say three things (§4.2): what is missing, why each
 * near-miss doesn't qualify — SPLIT BY AXIS, because the three axes need
 * opposite advice — and what would change the answer. Returns `null` when the
 * picker has something to offer, which is the caller's cue to render nothing.
 */
export function machineEmptyState<M extends HandoffMachine & { name?: string }>(
  summary: MachineChoiceSummary<M>,
  copy: MachineActionCopy,
): MachineEmptyState | null {
  if (summary.cause === 'none') return null
  const remedy = copy.remedy ? { remedy: copy.remedy } : {}
  switch (summary.cause) {
    case 'no-machines':
      return { title: `No machines are paired yet.`, ...remedy }
    case 'all-offline':
      return {
        // NAMED, and deliberately so: these machines CAN do the job, so telling
        // the user which ones to wake is the entire remedy.
        title: `No machine can ${copy.action} right now.`,
        detail: `${nameList(summary.offline)} ${summary.offline.length === 1 ? 'is' : 'are'} offline — bring ${summary.offline.length === 1 ? 'it' : 'one'} online.`,
      }
    case 'all-incapable':
      return {
        title: `No machine can ${copy.action} yet.`,
        detail:
          summary.incapable.length > 0
            ? `${nameList(summary.incapable)} runs only the Podium server — it has no daemon.`
            : `${nameList(summary.awaitingFirstConnection)} is waiting for its daemon's first connection.`,
        ...remedy,
      }
    case 'all-unauthorized':
      return {
        title: `No machine can ${copy.action}.`,
        detail: `${plural(summary.unauthorized.length, 'machine', 'machines')} you don't have access to. Ask its owner for access.`,
      }
    default:
      return {
        title: `No machine can ${copy.action} right now.`,
        detail: machineExclusionNote(summary, copy),
        ...remedy,
      }
  }
}

/** Machines that could satisfy `requirement` once online — the picker's LIST. */
export function machinesFor<M extends SelectableMachine>(
  machines: readonly M[],
  requirement: MachineRequirement,
): M[] {
  return machines.filter((machine) => structuralEligibility(machine, requirement) === undefined)
}

/** One machine's place in a picker built for a requirement. */
export interface MachineChoice<M> {
  machine: M
  /** `undefined` = selectable now; otherwise why it is disabled or excluded. */
  rejection?: MachineRejection
  /**
   * Whether the row belongs in the option list at all. `false` ONLY for the two
   * durable refusals — a row excluded here is counted in the footnote instead
   * (§4.1), never silently dropped.
   */
  listed: boolean
}

/**
 * THE PICKER PROJECTION: every visible machine, split into what may be offered
 * and what must be explained.
 *
 * Returns the whole population with a verdict each, rather than a filtered list,
 * for the reason POD-821 already settled for the handoff menu: a surface that
 * states its case cannot be confused with a broken eligibility gate, and a
 * silently-empty dropdown is the original defect of this issue.
 */
export function machineChoices<M extends HandoffMachine>(
  machines: readonly M[],
  requirement: MachineRequirement,
): MachineChoice<M>[] {
  return machines.map((machine) => {
    const structural = structuralEligibility(machine, requirement)
    const rejection = structural ?? machineRejection(machine, requirement)
    return { machine, ...(rejection ? { rejection } : {}), listed: structural === undefined }
  })
}

/**
 * ONE SENTENCE PER REFUSAL, shared by the picker, the server guard and the CLI
 * (§4.3).
 *
 * The words are here rather than at each surface because the whole failure this
 * work fixes is a surface saying the wrong thing about a machine: "bring it
 * online" is advice a server-only coordinator can never take, and a user who
 * follows it learns nothing. Keeping the sentence beside the predicate that
 * produced it means a new rejection member cannot ship with copy at only two of
 * its three surfaces.
 *
 * `action` is the verb phrase the caller needs, in the infinitive and without a
 * subject — "host repositories", "run claude-code", "receive this session",
 * "become the server".
 */
export function machineRejectionMessage(
  name: string,
  rejection: MachineRejection,
  action: string,
): string {
  switch (rejection) {
    case 'unauthorized':
      // Deliberately says nothing further. §3.2's oracle rule: a denied
      // machine's hidden state must not leak through its refusal reason.
      return `you do not have access to ${action} on machine '${name}'`
    case 'no-daemon':
      return `machine '${name}' runs no Podium daemon and cannot ${action}`
    case 'offline':
      return `machine '${name}' is offline — bring its daemon online, then retry`
    case 'harness-missing':
      return `machine '${name}' does not have the agent installed to ${action}`
    case 'logged-out':
      return `machine '${name}' is signed out of the agent needed to ${action}`
    case 'current-server':
      return `machine '${name}' is already the server`
    default: {
      const exhaustive: never = rejection
      return `machine '${name}' cannot ${action}: ${String(exhaustive)}`
    }
  }
}

/**
 * Why a picker has nothing to offer — the input to the empty state of §4.2.
 *
 * `cause` names the axis the user is actually on, because the three need
 * opposite advice: wake a machine, ask its owner, or install a daemon somewhere.
 * `'none'` means the picker is NOT empty and there is nothing to explain.
 */
export interface MachineChoiceSummary<M> {
  cause: 'none' | 'no-machines' | 'all-offline' | 'all-incapable' | 'all-unauthorized' | 'mixed'
  /** Selectable right now. */
  eligible: M[]
  /** Structurally fine, currently unreachable — listed and disabled. */
  offline: M[]
  /** Runs no daemon: excluded, counted, and never described as offline. */
  incapable: M[]
  /** Excluded with no further detail, per the oracle rule. */
  unauthorized: M[]
  /** Evaluated, runs nothing yet — a pairing whose daemon has never connected. */
  awaitingFirstConnection: M[]
}

/**
 * Summarize a picker's population so the surface can explain itself.
 *
 * `awaitingFirstConnection` is carved out of `incapable` rather than merged with
 * it because §4.1 keeps three states, not two: a brand-new row mid-pairing reads
 * "waiting for its daemon's first connection", which is a THIRD kind of advice
 * again (finish pairing), and calling it "runs the server only" would be false.
 */
export function machineChoiceSummary<M extends HandoffMachine>(
  choices: readonly MachineChoice<M>[],
): MachineChoiceSummary<M> {
  const eligible: M[] = []
  const offline: M[] = []
  const incapable: M[] = []
  const unauthorized: M[] = []
  const awaitingFirstConnection: M[] = []
  for (const choice of choices) {
    if (choice.rejection === undefined) eligible.push(choice.machine)
    else if (choice.rejection === 'unauthorized') unauthorized.push(choice.machine)
    else if (choice.rejection === 'no-daemon') {
      if (choice.machine.components?.length === 0) awaitingFirstConnection.push(choice.machine)
      else incapable.push(choice.machine)
    } else offline.push(choice.machine)
  }
  // Which single axis explains the emptiness: exactly one non-empty bucket gets
  // its own word, anything else is honestly `mixed` (the copy then lists each).
  const buckets = [
    ['all-offline', offline.length],
    ['all-incapable', incapable.length + awaitingFirstConnection.length],
    ['all-unauthorized', unauthorized.length],
  ] as const
  const occupied = buckets.filter(([, count]) => count > 0)
  const cause: MachineChoiceSummary<M>['cause'] =
    eligible.length > 0
      ? 'none'
      : choices.length === 0
        ? 'no-machines'
        : occupied.length === 1
          ? (occupied[0]?.[0] ?? 'mixed')
          : 'mixed'
  return { cause, eligible, offline, incapable, unauthorized, awaitingFirstConnection }
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
): 'harness-missing' | undefined {
  if (agentKind === 'shell') return undefined
  const harness = machine.inventory?.agents.find((agent) => agent.kind === agentKind)
  return harness?.installed === true ? undefined : 'harness-missing'
}

/** Online machines that can run `agentKind` according to their latest inventory. */
export function machinesForAgent<M extends HandoffMachine>(machines: M[], agentKind: string): M[] {
  return machines.filter(
    (machine) => agentCapabilityRejectionForSelection(machine, agentKind) === undefined,
  )
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
