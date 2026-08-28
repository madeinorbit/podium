/**
 * Requirement-aware machine capability projections.
 *
 * This module is intentionally separate from `machine-selection.ts`: the web
 * shell needs the small affinity/capability core during first paint, while the
 * picker projections and their explanatory copy are only used by lazy feature
 * surfaces. Keep the dependency one-way so those deferred surfaces do not pull
 * their full source text into the eager graph.
 */
import {
  type AgentCapabilityRejection,
  type AgentLoginCondition,
  type HandoffMachine,
  harnessRejection,
  type SelectableMachine,
  structuralRejection,
} from './machine-selection'

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
 * point in `machine-handoff.ts`, which composes the capability core from there.
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
    // The two PROBE-STATE members the agent-runtime epic added (POD-3070 merge).
    // Both are "not yet known", not "no" — the sentence has to say that, because
    // the advice is to wait or retry rather than to install anything.
    case 'inventory-unavailable':
      return `machine '${name}' has not reported what it can run yet — wait for its probe, then retry`
    case 'harness-probe-timed-out':
      return `could not determine whether machine '${name}' can ${action} — its probe timed out; retry`
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
