/**
 * Shared harness for the agent-mail CHARACTERIZATION suites (POD-727, step 1 of
 * the POD-640 mini-epic). These suites pin the CURRENT behaviour of the mail
 * vertical so POD-728 (mail contracts + handlers) and POD-729 (cutover and
 * deletion) can be proven behaviour-preserving instead of merely compiling.
 *
 * Design rules for this harness — they are what makes the suites an oracle
 * rather than a restatement of the implementation:
 *
 *  - REAL collaborators wherever a behaviour depends on them. The IssueService,
 *    SessionStore (messages repo, events, issue_messages mirror), the
 *    MessageDeliveryService, MessageGate and the spawn-on-wake wiring are all
 *    the production objects. In particular the real `IssueService.resolveRef` is
 *    what makes the unknown-id vs out-of-scope-id error divergence observable —
 *    a hand-written fake that throws on an unknown ref would hide it.
 *  - The ONLY fakes are the two things a unit test cannot have: the PTY
 *    transport (sendText/queueText/interruptText, recorded verbatim so bodies
 *    can be asserted BYTE-FOR-BYTE) and the session inventory.
 *  - The clock is injected and advanced explicitly. No test in these suites may
 *    sleep before an assertion (POD-757): a fixed sleep before an assertion is
 *    itself a bug, so waits are driven by advancing this clock or by a
 *    predicate-driven `sleep` seam.
 */

import type { HumanCeiling } from '@podium/commands'
import type { AgentPhase, SessionMeta } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import type { Capability } from '../../issue-authz'
import { SessionStore } from '../../store'
import { type IssueDeps, IssueService } from '../issues/service'
import { issueTestPlumbing } from '../issues/service/test-plumbing'
import { MessageGate, type MessageGateDeps } from './gate'
import type { MachineAccess } from './handlers/context'
import { type MessageDeliveryDeps, MessageDeliveryService } from './service'
import { makeSpawnOnWake } from './spawn'

/** One recorded push at the PTY transport seam. `text` is captured verbatim —
 *  byte-fidelity assertions read it with no normalisation whatsoever. */
export interface Push {
  fn: 'sendText' | 'queueText' | 'interruptText'
  sessionId: string
  text: string
  inputOrigin?: string
}

export interface TransportBehaviour {
  ok?: boolean
  queued?: boolean
  reason?: string
  /** Restrict a configured failure to these session ids (default: all). Needed
   *  to characterize the unresumable-wake path, where the push to the DEAD
   *  session must fail while the push to the freshly spawned child succeeds. */
  failSessions?: string[]
}

export interface SessionFixture {
  sessionId: string
  status?: SessionMeta['status']
  phase?: AgentPhase
  cwd?: string
  issueId?: string
  spawnedBy?: string
  agentKind?: string
  lastActiveAt?: string
  /** Composer-draft presence [POD-865]; any value = a hold. */
  draftUpdatedAt?: string
  queuedMessageCount?: number
  machineId?: string
  busy?: boolean
  title?: string
}

/** A minimal, well-typed agentState for a phase — used when a test moves a live
 *  session's phase mid-scenario (a turn ending, a child blocking). */
export function phaseState(phase: AgentPhase): NonNullable<SessionMeta['agentState']> {
  return { phase, since: '2026-07-20T12:00:00.000Z', nativeSubagentCount: 0 }
}

/** A SessionMeta good enough for every code path the mail vertical exercises. */
export function session(f: SessionFixture): SessionMeta {
  const meta = {
    sessionId: f.sessionId,
    agentKind: (f.agentKind ?? 'claude-code') as SessionMeta['agentKind'],
    title: f.title ?? f.sessionId,
    cwd: f.cwd ?? '/repo',
    status: f.status ?? 'live',
    controllerId: 'c0',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: f.lastActiveAt ?? '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' as const },
    archived: false,
    readAt: null,
    unread: false,
    ...(f.phase ? { agentState: { phase: f.phase } } : {}),
    ...(f.busy !== undefined ? { busy: f.busy } : {}),
    ...(f.issueId ? { issueId: f.issueId } : {}),
    ...(f.spawnedBy ? { spawnedBy: f.spawnedBy } : {}),
    ...(f.draftUpdatedAt ? { draftUpdatedAt: f.draftUpdatedAt } : {}),
    ...(f.queuedMessageCount !== undefined ? { queuedMessageCount: f.queuedMessageCount } : {}),
    ...(f.machineId ? { machineId: f.machineId } : {}),
  }
  return meta as unknown as SessionMeta
}

export interface HarnessOptions {
  /** Fixed start of the injected clock. */
  startedAt?: string
  /** Gate spawn seam override — e.g. to characterize an unreachable machine. */
  spawnSession?: MessageGateDeps['spawnSession']
  resolveExecutionProfile?: MessageGateDeps['resolveExecutionProfile']
  /** Omit the wake-spawn seam entirely (the unwired-server arm). */
  omitSpawnOnWake?: boolean
  /** Poll interval handed to the gate's blocking-send / await seams. */
  awaitPollMs?: number
  /**
   * Called on every poll of a bounded wait (the injected `sleep` seam), with the
   * 1-based poll number. This is how a test drives a state change DURING a
   * blocking wait without ever sleeping on the wall clock (POD-757: a fixed
   * sleep before an assertion is itself a bug).
   */
  onPoll?(poll: number): void
  /**
   * ADDITIVE, POD-728. The multi-user seams the mail vertical now consults, so a
   * test can exercise them without a second harness. Every default is exactly
   * today's single-user behaviour, so no existing characterization changes:
   * the ceiling is at its maximum, every machine is usable and reachable, and
   * the apply-time gate allows. NO ASSERTION IN ANY POD-727 SUITE WAS TOUCHED BY
   * ADDING THESE.
   */
  ceiling?: HumanCeiling
  machines?: MachineAccess
  authorizeAtApply?: MessageDeliveryDeps['authorizeAtApply']
}

export interface MailHarness {
  store: SessionStore
  issues: IssueService
  svc: MessageDeliveryService
  gate: MessageGate
  /** Live session inventory — mutate in place to change delivery-time state. */
  sessions: SessionMeta[]
  /** Every push at the transport seam, in order, bodies verbatim. */
  pushes: Push[]
  /** Wake-spawn createSession calls (the spawn-on-wake seam). */
  wakeSpawns: Record<string, unknown>[]
  /** Gate spawnAgent calls (the direct `podium agent spawn` seam). */
  gateSpawns: Record<string, unknown>[]
  /** Next transport outcome; set to make a push fail. */
  transport: TransportBehaviour
  now(): string
  advance(ms: number): void
  setNow(iso: string): void
  /** Create an issue and return its row-ish metadata. */
  createIssue(input: { title: string; repoPath?: string; parentId?: string }): {
    id: string
    seq: number
  }
  /** Attach a worktree path to an issue (issue-membership by cwd). Goes through
   *  the IssueService, not the raw store: the service holds the authoritative
   *  in-memory rows and a direct store write is invisible to it. */
  setWorktree(issueId: string, worktreePath: string): void
  archive(issueId: string): void
  put(...fixtures: SessionFixture[]): SessionMeta[]
  /** A capability for an agent bound to an issue subtree. */
  agentCap(issueId: string, sessionId?: string): Capability
  events(kinds?: string[]): { kind: string; subject: string; payload: unknown }[]
}

const OPERATOR_CAP: Capability = { role: 'admin', scope: { kind: 'all' } }
export const OPERATOR = OPERATOR_CAP

export function mailHarness(opts?: HarnessOptions): MailHarness {
  const store = new SessionStore(':memory:')
  const sessions: SessionMeta[] = []
  const pushes: Push[] = []
  const wakeSpawns: Record<string, unknown>[] = []
  const gateSpawns: Record<string, unknown>[] = []
  const transport: TransportBehaviour = {}
  let nowMs = Date.parse(opts?.startedAt ?? '2026-07-20T12:00:00.000Z')
  let polls = 0
  const now = (): string => new Date(nowMs).toISOString()

  const issueDeps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: 'main',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: () => ({ sessionId: 'unused' }),
    repoOp: async () => ({ ok: true, output: '' }),
    ...issueTestPlumbing(),
    now,
  }
  const issues = new IssueService(issueDeps)

  const record =
    (fn: Push['fn']) => (i: { sessionId: string; text: string; inputOrigin?: string }) => {
      pushes.push({ fn, ...i })
      const fails =
        transport.ok === false &&
        (transport.failSessions === undefined || transport.failSessions.includes(i.sessionId))
      if (fails) {
        return { ok: false, ...(transport.reason ? { reason: transport.reason } : {}) }
      }
      return { ok: true, ...(transport.queued !== undefined ? { queued: transport.queued } : {}) }
    }

  const svc = new MessageDeliveryService({
    messages: store.messages,
    notificationFacts: store.notificationFacts,
    events: store.events,
    issues: () => issues,
    sessions: () => ({
      listSessions: () => sessions,
      sendText: record('sendText'),
      queueText: record('queueText'),
      interruptText: record('interruptText'),
    }),
    // Production wires both legacy-mirror seams; the #463 regression class and
    // the read-consumption semantics both run through them.
    mirrorIssueMail: (row) => store.issues.addIssueMessage(row),
    mirrorMarkIssueMailRead: (issueId, ids) =>
      store.issues.markIssueMessagesRead(issueId, ids, now()),
    ...(opts?.authorizeAtApply ? { authorizeAtApply: opts.authorizeAtApply } : {}),
    transact: (fn) => store.transact(fn),
    ...(opts?.omitSpawnOnWake
      ? {}
      : {
          spawnOnWake: makeSpawnOnWake({
            issues: () => issues,
            createSession: (input) => {
              wakeSpawns.push(input as unknown as Record<string, unknown>)
              const sessionId = `woken${wakeSpawns.length}`
              sessions.push(
                session({
                  sessionId,
                  status: 'starting',
                  ...(input.issueId ? { issueId: input.issueId } : {}),
                  ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
                }),
              )
              return { sessionId }
            },
          }),
        }),
    now,
  })

  const gate = new MessageGate(
    {
      messages: () => svc,
      issues: () => issues,
      listSessions: () => sessions,
      spawnSession:
        opts?.spawnSession ??
        ((input) => {
          gateSpawns.push(input as unknown as Record<string, unknown>)
          const sessionId = `child${gateSpawns.length}`
          sessions.push(
            session({
              sessionId,
              status: 'starting',
              ...(input.issueId ? { issueId: input.issueId } : {}),
              ...(input.spawnedBy ? { spawnedBy: input.spawnedBy } : {}),
            }),
          )
          return { sessionId }
        }),
      ...(opts?.resolveExecutionProfile
        ? { resolveExecutionProfile: opts.resolveExecutionProfile }
        : {}),
      createIssue: (input) => issues.create({ ...input, startNow: false }),
      appendEvent: (e) => store.events.appendEvent(e),
      // Deterministic poll seam (POD-757: never sleep before an assertion). A
      // "sleep" advances the INJECTED clock by exactly the requested amount and
      // returns immediately, so a bounded wait converges through its real polling
      // loop with zero wall-clock time. `onPoll` lets a test flip state mid-wait.
      sleep: (ms: number) => {
        nowMs += ms
        polls += 1
        opts?.onPoll?.(polls)
        return Promise.resolve()
      },
      awaitPollMs: opts?.awaitPollMs ?? 500,
      now,
      retireNotificationFact: (factKey, target) =>
        store.notificationFacts.retire(factKey, target, now()),
    },
    {
      ...(opts?.ceiling ? { ceiling: opts.ceiling } : {}),
      ...(opts?.machines ? { machines: opts.machines } : {}),
    },
  )

  return {
    store,
    issues,
    svc,
    gate,
    sessions,
    pushes,
    wakeSpawns,
    gateSpawns,
    transport,
    now,
    advance: (ms) => {
      nowMs += ms
    },
    setNow: (iso) => {
      nowMs = Date.parse(iso)
    },
    createIssue: (input) => {
      const wire = issues.create({
        repoPath: input.repoPath ?? '/repo',
        title: input.title,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        startNow: false,
      })
      return { id: wire.id, seq: wire.seq }
    },
    setWorktree: (issueId, worktreePath) => {
      issues.update(issueId, { worktreePath })
    },
    archive: (issueId) => {
      issues.update(issueId, { archived: true })
    },
    put: (...fixtures) => {
      const created = fixtures.map(session)
      sessions.push(...created)
      return created
    },
    agentCap: (issueId, sessionId) => ({
      role: 'worker',
      scope: { kind: 'subtree', rootId: issueId },
      ...(sessionId ? { actorSessionId: sessionId } : {}),
    }),
    events: (kinds) =>
      store.events
        .listEventsSince(0, kinds ? { kinds, limit: 5000 } : { limit: 5000 })
        .map((e) => ({ kind: e.kind, subject: e.subject, payload: e.payload })),
  }
}
