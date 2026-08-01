/**
 * SessionService ORACLE support (POD-392, the decomposition oracle for
 * POD-393/POD-394/POD-395; originally established by POD-379).
 *
 * The oracle suite pins TODAY's observable behaviour of every session write, so
 * the 3.2 migration onto command contracts (POD-380 presence class, POD-381
 * command plane, POD-642 handoff, POD-382 the cutover that deletes the
 * hand-written router mutations) can be proven behaviour-preserving instead of
 * merely compiling.
 *
 * ## The two tags, and why the split exists
 *
 * A green oracle must never be used as evidence that a DELIBERATE replacement is
 * a regression (docs/multi-user-readiness.md §3.1/§3.3). So every
 * characterization declares which kind of statement it is:
 *
 *  - {@link MUST_NOT_CHANGE} — behaviour the migration must preserve verbatim.
 *    A red test here is a regression.
 *  - {@link willChange} — behaviour a NAMED later issue deliberately replaces. A
 *    red test here means "read the superseding issue, then update this
 *    characterization" — never "restore the old behaviour".
 *  - {@link provisional} — current-head behaviour touching an OPEN readiness
 *    decision or a required multi-user property that has not reached this
 *    service yet. It is evidence, not a preservation demand.
 *
 * The tag is part of the test NAME so it shows up in the failure line, and
 * oracle-tags.test.ts enforces that every oracle test carries one.
 *
 * ## What the assertions are allowed to look at
 *
 * Only wire messages, persisted rows, control messages and returned values —
 * never UI copy, and never a bare substring of a longer string (POD-743: a
 * substring assertion that happens to match unrelated prose passes
 * unconditionally). Error messages are pinned with EXACT equality, because
 * docs/multi-user-readiness.md §3.1.4 M5 and §3.1.5 both need the literal shape
 * as a later comparison baseline.
 */

import { FIRST_ADMIN_USER_ID, type SessionId } from '@podium/model'
import type { ControlMessage, ServerMessage } from '@podium/protocol'
import { OPERATOR } from '../../issue-authz'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { SessionStore } from '../../store'
import { SuperagentService } from '../superagent'

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** This behaviour must survive the POD-312 migration byte-for-byte. */
export const MUST_NOT_CHANGE = 'must-not-change'

/** Issues that deliberately supersede a characterized behaviour. */
export const SUPERSEDING_ISSUES = [
  // Real user identity + per-user principal (one shared password today).
  'POD-1075',
  // Authorization over human-vs-human (agent-capability only today).
  'POD-1073',
  // Machines as owned compute: see / use / manage (ambient placement today).
  'POD-1079',
  // POD-1076 HAS LANDED and is deliberately NOT listed any more. It superseded one
  // characterization — session `readAt` as a single instance-wide value — by
  // re-keying the marker onto `(userId, sessionId)`. `oracle-session-state.test.ts` now
  // pins the RESIDUAL as must-not-change: the storage is per user, and the still-
  // unscoped feed serves one viewer to every DEVICE of that person (POD-1077 scopes
  // the feed; the row already has an owner, so nothing about it changes then).
  //
  // POD-642 HAS LANDED and is deliberately NOT listed any more. It superseded one
  // characterization — concurrent duplicate handoff dispatch running two complete
  // orchestrations — and `oracle-handoff.test.ts` now pins the single-flighted
  // behaviour as must-not-change instead. Keeping a superseding issue in this list
  // after its supersession would leave the ratchet asserting that a pending change
  // is still pending, which is how a stale will-change tag survives forever.
] as const

export type SupersedingIssue = (typeof SUPERSEDING_ISSUES)[number]

/**
 * Tag a characterization of behaviour a later issue REPLACES. `issue` must be
 * one of {@link SUPERSEDING_ISSUES}; `why` names the replacement in one clause.
 */
export function willChange(issue: SupersedingIssue, why: string): string {
  return `will-change ${issue} (${why})`
}

/** Open decisions and documented current-head gaps the split must not freeze. */
export const PROVISIONAL_REFERENCES = [
  'readiness-3.1.1',
  'readiness-3.1.2',
  'readiness-3.1.3-A4',
  'readiness-3.3',
  'readiness-4',
  'POD-393',
  'POD-1070',
] as const

export type ProvisionalReference = (typeof PROVISIONAL_REFERENCES)[number]

/**
 * Mark an observation as evidence only. The named reference is the authority
 * that may deliberately replace it during the split.
 */
export function provisional(reference: ProvisionalReference, why: string): string {
  return `provisional ${reference} (${why})`
}

// ---------------------------------------------------------------------------
// One-machine oracle fixture
// ---------------------------------------------------------------------------

export interface Oracle {
  reg: SessionRegistry
  store: SessionStore
  /** Every ServerMessage broadcast to the (single) attached client. */
  client: ServerMessage[]
  /** Every ControlMessage the server sent to the attached daemon. */
  daemon: ControlMessage[]
  /** tRPC caller with the OPERATOR capability — the human seam. */
  call: ReturnType<typeof appRouter.createCaller>
  /** Session metadata as the wire sees it. */
  meta(
    sessionId: SessionId,
  ): ReturnType<SessionRegistry['modules']['sessions']['listSessions']>[number]
  /**
   * Invoke a write the way a RELAYED AGENT does — through the capability seam,
   * with the capability minted from the calling session's cwd. This is the ONLY
   * authorization boundary the product has today: the tRPC surface above is
   * unconditionally OPERATOR (one shared password ⇒ admin/all).
   */
  relay(req: RelayRequest): Promise<RelayReply>
  dispose(): void
}

export type RelayReply = Extract<ControlMessage, { type: 'agentRelayResult' }>

export interface RelayRequest {
  requestId: string
  /** The CALLING session — the relay context the capability is minted from. */
  sessionId: SessionId
  router: string
  proc: string
  input?: unknown
  outsideScope?: boolean
}

const registries: SessionRegistry[] = []

/** A machine row that exists but has NO daemon attached — i.e. offline. */
export interface OfflineMachine {
  id: string
  name: string
  /** Harnesses the machine reported before it went away. */
  agents?: { kind: string; installed: boolean; login: { state: 'in' | 'out' } }[]
}

/**
 * Build a fixture with one paired machine, one attached client, one daemon.
 *
 * `offlineMachines` rows are written BEFORE the registry is constructed: the
 * machines service caches its records, so a row inserted afterwards reads as an
 * unknown machine rather than an offline one.
 */
export function makeOracle(
  opts: { machineId?: string; offlineMachines?: OfflineMachine[] } = {},
): Oracle {
  const machineId = opts.machineId ?? 'local'
  const store = new SessionStore(':memory:')
  for (const machine of opts.offlineMachines ?? []) {
    store.machines.upsertMachine({
      id: machine.id,
      name: machine.name,
      hostname: machine.id,
      tokenHash: `hash-${machine.id}`,
      // The oracle's fixture fleet belongs to the instance's one account: these
      // rows stand in for machines the operator paired (POD-1079).
      ownerUserId: FIRST_ADMIN_USER_ID,
    })
    store.machines.setMachineInventory(
      machine.id,
      JSON.stringify({
        os: 'linux',
        arch: 'x64',
        agents: machine.agents ?? [
          { kind: 'claude-code', installed: true, login: { state: 'in' } },
        ],
        tools: [],
      }),
    )
  }
  const reg = new SessionRegistry(store)
  registries.push(reg)
  const daemon: ControlMessage[] = []
  const client: ServerMessage[] = []
  /** Extra sinks the relay helper installs; the daemon send fn is single-slot. */
  const relayWaiters: ((msg: ControlMessage) => void)[] = []
  reg.gateway.attachDaemon(machineId, (msg) => {
    daemon.push(msg)
    for (const waiter of relayWaiters) waiter(msg)
    // Answer the one RPC a session write makes of its daemon: `stop` inspects the
    // worktree for unsaved work. A clean tree is the ordinary case; leaving it
    // unanswered would turn every stop test into a 20s RPC timeout rather than a
    // characterization. Tests that want the dirty-tree refusal drive it explicitly.
    if (msg.type === 'repoOpRequest') {
      reg.gateway.routeDaemonFrame(machineId, {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: true,
        output: '',
      })
    }
  })
  reg.clientGateway.attachClient((msg) => client.push(msg))
  const repos = new RepoRegistry(reg, reg.sessionStore)
  const superagent = new SuperagentService(reg.modules, repos, reg.sessionStore)
  const call = appRouter.createCaller({
    registry: reg,
    repos,
    superagent,
    capability: OPERATOR,
  })
  return {
    reg,
    store,
    client,
    daemon,
    call,
    meta: (sessionId) => {
      const found = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
      if (!found) throw new Error(`no session meta for ${sessionId}`)
      return found
    },
    relay: (req) =>
      new Promise<RelayReply>((resolve) => {
        relayWaiters.push((msg) => {
          if (msg.type === 'agentRelayResult' && msg.requestId === req.requestId) resolve(msg)
        })
        reg.gateway.routeDaemonFrame(machineId, {
          type: 'agentRelayRequest',
          requestId: req.requestId,
          sessionId: req.sessionId,
          router: req.router,
          proc: req.proc,
          input: req.input,
          ...(req.outsideScope ? { outsideScope: true } : {}),
        })
      }),
    dispose: () => reg.dispose(),
  }
}

/** Dispose every registry built by {@link makeOracle} (call from afterEach). */
export function disposeOracles(): void {
  for (const reg of registries.splice(0)) reg.dispose()
}

// ---------------------------------------------------------------------------
// Predicate waiting (never a fixed sleep — POD-757)
// ---------------------------------------------------------------------------

/** Resolve once `predicate()` holds, polling the macrotask queue. Throws on timeout. */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

// ---------------------------------------------------------------------------
// PTY frames
// ---------------------------------------------------------------------------

/** Bracketed-paste wrapper the substrate types pasted text inside. */
export const PASTE_START = '\u001b[200~'
export const PASTE_END = '\u001b[201~'

/**
 * Every PTY input frame the server sent, decoded. Assertions compare the WHOLE
 * sequence with exact equality — never a substring of a joined blob, which can
 * match unrelated bytes and hide an added wrapper or a second frame (POD-743).
 */
export function ptyFrames(
  daemon: ControlMessage[],
): { inputOrigin: string | undefined; data: string }[] {
  return daemon
    .filter((m): m is Extract<ControlMessage, { type: 'input' }> => m.type === 'input')
    .map((m) => ({ inputOrigin: m.inputOrigin, data: Buffer.from(m.data, 'base64').toString() }))
}

/** The message a thrown/rejected write carries, with no substring matching. */
export async function messageOf(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the write to fail, but it resolved')
}
