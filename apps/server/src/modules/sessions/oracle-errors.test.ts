/**
 * ORACLE — error shapes of session writes (POD-379 for POD-312).
 *
 * Two later properties depend on having today's shapes written down:
 *
 *  1. §3.1.5's consistent-error rule — once sessions can be INVISIBLE to a
 *     principal, acting on an invisible session must fail IDENTICALLY to acting
 *     on a nonexistent one, or the command surface becomes an existence oracle.
 *     Durable session state now takes the closed default: session-scoped rows
 *     silently refuse unknown targets. Other command families retain their
 *     established result and throw shapes, which this file still records.
 *
 *  2. §3.1.4 M5 — unauthorized and unreachable must be DISTINGUISHABLE. Today
 *     there is no unauthorized-machine case at all (placement is ambient), so
 *     only the unreachable shape can be recorded; it is recorded here so the
 *     later split has something concrete to be different from.
 *
 * Messages are pinned with EXACT equality, never a substring (POD-743).
 */

import { SOLE_USER_ID } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  disposeOracles,
  MUST_NOT_CHANGE,
  makeOracle,
  messageOf,
  provisional,
  willChange,
} from './oracle-support'

afterEach(() => disposeOracles())

const GHOST = '00000000-0000-4000-8000-000000000000'
const EXISTENCE_ORACLE = provisional(
  'readiness-3.1.2',
  'existence-leak policy is deliberately open; these are current comparison shapes',
)
const SESSION_STATE_CLOSED_DEFAULT = provisional(
  'POD-1070',
  'durable session state defaults closed; the ownership matrix may later revisit the product policy',
)

describe('oracle: not-found shape, per write', () => {
  it(`${EXISTENCE_ORACLE}: rename gives the Outbox a normalized refusal while the remaining session-state writes stay silent`, async () => {
    const o = makeOracle()

    await expect(o.call.sessions.rename({ sessionId: GHOST, name: 'x' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'command refused',
    })
    await expect(
      o.call.sessions.setArchived({ sessionId: GHOST, archived: true }),
    ).resolves.toBeUndefined()
    await expect(o.call.sessions.markRead({ sessionId: GHOST })).resolves.toBeUndefined()
    await expect(o.call.sessions.markUnread({ sessionId: GHOST })).resolves.toBeUndefined()
    await expect(
      o.call.sessions.setWorkState({ sessionId: GHOST, workState: 'done' }),
    ).resolves.toBeUndefined()
    await expect(
      o.call.sessions.setIssueId({ sessionId: GHOST, issueId: null }),
    ).resolves.toBeUndefined()

    expect(o.store.sessions.loadSessions()).toEqual([])
    expect(o.reg.modules.sessions.listSessions()).toEqual([])
  })

  it(`${SESSION_STATE_CLOSED_DEFAULT}: snooze writes on an unknown session are silent no-ops with no row`, async () => {
    const o = makeOracle()

    await expect(o.call.snoozes.set({ sessionId: GHOST, until: null })).resolves.toBeUndefined()
    expect(o.store.sessions.listSnoozes(SOLE_USER_ID)).toEqual({})
    await expect(o.call.snoozes.clear({ sessionId: GHOST })).resolves.toBeUndefined()
  })

  it(`${SESSION_STATE_CLOSED_DEFAULT}: polymorphic panel pins remain valid, while tab order rejects an unknown session`, async () => {
    const o = makeOracle()

    expect(await o.call.pins.set({ kind: 'panel', id: GHOST, pinned: true })).toEqual({
      panels: [GHOST],
      worktrees: [],
      repos: [],
    })
    await expect(
      o.call.tabs.setOrder({ worktree: '/nowhere', sessionIds: [GHOST] }),
    ).resolves.toBeUndefined()
    expect(o.store.sessions.listTabOrders(SOLE_USER_ID)).toEqual({})
  })

  it(`${EXISTENCE_ORACLE}: the lifecycle primitives REPORT not-found as a returned reason`, async () => {
    const o = makeOracle()

    expect(await o.call.sessions.hibernate({ sessionId: GHOST })).toEqual({
      ok: false,
      reason: 'unknown session',
    })
    expect(await o.call.sessions.resurrect({ sessionId: GHOST })).toEqual({
      ok: false,
      reason: 'unknown session',
    })
    expect(
      await o.call.sessions.answerAskUserQuestion({
        sessionId: GHOST,
        choices: [{ optionIndices: [1] }],
      }),
    ).toEqual({ ok: false })
  })

  it(`${EXISTENCE_ORACLE}: continue and stop disagree with each other — continue reports a bare ok:false, stop names the cause`, async () => {
    const o = makeOracle()

    // Same class of failure (the session does not exist), two different shapes.
    expect(await o.call.sessions.continue({ sessionId: GHOST })).toEqual({ ok: false })
    expect(await o.call.sessions.stop({ sessionId: GHOST })).toEqual({
      ok: false,
      reason: 'unknown session',
    })
  })

  it(`${EXISTENCE_ORACLE}: handoff THROWS on an unknown session — the only session write whose not-found path is an exception`, async () => {
    const o = makeOracle()

    expect(
      await messageOf(() => o.call.sessions.handoff({ sessionId: GHOST, machineId: 'local' })),
    ).toBe('unknown session')
  })

  it(`${EXISTENCE_ORACLE}: kill on an unknown session neither throws nor creates a tombstone`, async () => {
    const o = makeOracle()

    await expect(o.call.sessions.kill({ sessionId: GHOST })).resolves.toBeUndefined()

    expect(o.store.sessions.loadDeletedSessions()).toEqual([])
  })

  it(`${EXISTENCE_ORACLE}: a send to an unknown session DEAD-LETTERS (ok:false) rather than queueing into a black hole`, async () => {
    const o = makeOracle()

    const sent = await o.call.sessions.sendText({ sessionId: GHOST, text: 'anyone there' })
    expect(sent.ok).toBe(false)
    expect(sent.disposition).toBe('dead_letter')

    const woken = await o.call.sessions.resumeAndSend({ sessionId: GHOST, text: 'anyone there' })
    expect(woken.ok).toBe(false)
    expect(woken.disposition).toBe('dead_letter')
  })

  it(`${EXISTENCE_ORACLE}: via the RELAY, not-found and authz-denied are DIFFERENT messages — the send path is an existence oracle today`, async () => {
    const o = makeOracle()
    const a = o.reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    o.reg.issues.update(a.id, { worktreePath: '/r/.worktrees/a' })
    const b = o.reg.issues.create({ repoPath: '/r', title: 'B', startNow: false })
    o.reg.issues.update(b.id, { worktreePath: '/r/.worktrees/b' })
    const agent = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })
    // A session that EXISTS but is outside the caller's subtree — the invisible
    // case's closest present-day analogue.
    const stranger = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/b',
      issueId: b.id,
    })

    const notFound = await o.relay({
      requestId: 'send-ghost',
      sessionId: agent.sessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: GHOST, text: 'hi' },
    })
    const denied = await o.relay({
      requestId: 'send-denied',
      sessionId: agent.sessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: stranger.sessionId, text: 'hi' },
    })

    // The name claims DISTINCT, so the test compares them rather than pinning one
    // and trusting the reader. Both are pinned exactly, and their difference is
    // asserted — that difference IS the existence oracle §3.1.5 has to close.
    expect(notFound.ok).toBe(false)
    expect(denied.ok).toBe(false)
    expect(notFound.error).toBe('session not found')
    expect(denied.error).toBe(
      `issue ${b.id} is outside your subtree; re-run with --outside-scope to confirm`,
    )
    expect(notFound.error).not.toBe(denied.error)
  })
})

describe('oracle: unreachable machine (the shape §3.1.4 M5 must stay distinguishable from "unauthorized")', () => {
  /** A paired machine that reported an inventory and then went away. */
  const OFFLINE = [{ id: 'gone', name: 'Gone' }]

  it(`${MUST_NOT_CHANGE}: create against an OFFLINE machine throws, naming the machine and the reachability fault`, async () => {
    const o = makeOracle({ offlineMachines: OFFLINE })

    expect(
      await messageOf(() =>
        o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p', machineId: 'gone' }),
      ),
    ).toBe("machine 'Gone' is offline")
    expect(o.reg.modules.sessions.listSessions()).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: resume against an OFFLINE machine throws the same reachability message as create, and spawns nothing`, async () => {
    const o = makeOracle({ offlineMachines: OFFLINE })

    expect(
      await messageOf(() =>
        o.call.sessions.resume({
          agentKind: 'claude-code',
          cwd: '/p',
          resume: { kind: 'claude-session', value: 'n1' },
          conversationId: 'n1',
          machineId: 'gone',
        }),
      ),
    ).toBe("machine 'Gone' is offline")
    expect(o.reg.modules.sessions.listSessions()).toEqual([])
    expect(o.daemon.filter((m) => m.type === 'spawn')).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: both send paths distinguish an unreachable machine from authorization refusal`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    // The machine drops off: no daemon socket, so nothing can reach the PTY.
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    expect(o.meta(sessionId).status).toBe('reconnecting')
    o.daemon.length = 0

    const sent = await o.call.sessions.sendText({ sessionId, text: 'anyone there' })
    const woken = await o.call.sessions.resumeAndSend({ sessionId, text: 'anyone there' })

    expect(sent).toEqual({
      ok: false,
      reason: 'machine unreachable',
      disposition: 'dead_letter',
    })
    expect(woken).toEqual({
      ok: false,
      reason: 'machine unreachable',
      disposition: 'dead_letter',
    })
    expect(o.daemon.filter((m) => m.type === 'input')).toEqual([])
  })

  it(`${MUST_NOT_CHANGE}: an UNKNOWN machine id is a different message from an offline one`, async () => {
    const o = makeOracle()

    expect(
      await messageOf(() =>
        o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p', machineId: 'never-paired' }),
      ),
    ).toBe("unknown machine 'never-paired'")
  })

  it(`${MUST_NOT_CHANGE}: handoff to an offline machine is refused BEFORE anything is stopped or moved`, async () => {
    const o = makeOracle({ offlineMachines: OFFLINE })
    o.store.repos.addRepo('/r', 'local', 'git@github.com:example/r.git')
    const { sessionId } = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/r/.worktrees/x',
      resume: { kind: 'claude-session', value: 'n1' },
      conversationId: 'n1',
    })

    expect(await messageOf(() => o.call.sessions.handoff({ sessionId, machineId: 'gone' }))).toBe(
      'target machine is offline',
    )
    // Nothing moved, nothing parked, and no handover overlay was ever painted.
    expect(o.meta(sessionId)).toMatchObject({ machineId: 'local', status: 'starting' })
    expect(o.meta(sessionId).handoffTarget).toBeUndefined()
  })
})
