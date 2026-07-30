/**
 * ORACLE — error shapes of session writes (POD-379 for POD-312).
 *
 * Two later properties depend on having today's shapes written down:
 *
 *  1. §3.1.5's consistent-error rule — once sessions can be INVISIBLE to a
 *     principal, acting on an invisible session must fail IDENTICALLY to acting
 *     on a nonexistent one, or the command surface becomes an existence oracle.
 *     That assertion needs today's not-found shape as its comparison baseline.
 *     Today that shape is NOT uniform, and this file records the whole spread:
 *     silent no-op, `{ ok: false, reason }`, a throw, and — for snoozes / pins /
 *     tab order — a write that SUCCEEDS against an id that does not exist.
 *
 *  2. §3.1.4 M5 — unauthorized and unreachable must be DISTINGUISHABLE. Today
 *     there is no unauthorized-machine case at all (placement is ambient), so
 *     only the unreachable shape can be recorded; it is recorded here so the
 *     later split has something concrete to be different from.
 *
 * Messages are pinned with EXACT equality, never a substring (POD-743).
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  disposeOracles,
  MUST_NOT_CHANGE,
  makeOracle,
  messageOf,
  willChange,
} from './oracle-support'

afterEach(() => disposeOracles())

const GHOST = '00000000-0000-4000-8000-000000000000'
const EXISTENCE_ORACLE = willChange(
  'POD-1073',
  'invisible must later fail identically to nonexistent — §3.1.5',
)

describe('oracle: not-found shape, per write', () => {
  it(`${EXISTENCE_ORACLE}: the presence writes are SILENT NO-OPS on an unknown session — no throw, no row, no reason`, async () => {
    const o = makeOracle()

    await expect(o.call.sessions.rename({ sessionId: GHOST, name: 'x' })).resolves.toBeUndefined()
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

  it(`${EXISTENCE_ORACLE}: snooze SET on an unknown session SUCCEEDS and durably creates a row (clear stays a no-op)`, async () => {
    const o = makeOracle()

    // Asymmetric with rename/archive above: the snooze table is keyed by session
    // id with no foreign key, so this write persists against a ghost.
    expect(await o.call.snoozes.set({ sessionId: GHOST, until: null })).toEqual({ [GHOST]: null })
    expect(o.store.sessions.listSnoozes()).toEqual({ [GHOST]: null })

    expect(await o.call.snoozes.clear({ sessionId: GHOST })).toEqual({})
  })

  it(`${EXISTENCE_ORACLE}: pins and tab order accept ids that do not exist — they are not existence-checked at all`, async () => {
    const o = makeOracle()

    expect(await o.call.pins.set({ kind: 'panel', id: GHOST, pinned: true })).toEqual({
      panels: [GHOST],
      worktrees: [],
      repos: [],
    })
    expect(await o.call.tabs.setOrder({ worktree: '/nowhere', sessionIds: [GHOST] })).toEqual({
      '/nowhere': [GHOST],
    })
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

  it(`${EXISTENCE_ORACLE}: via the RELAY, a send to an unknown session fails with a distinct message from an authz denial`, async () => {
    const o = makeOracle()
    const issue = o.reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/a' })
    const agent = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })

    const reply = await o.relay({
      requestId: 'send-ghost',
      sessionId: agent.sessionId,
      router: 'sessions',
      proc: 'sendText',
      input: { sessionId: GHOST, text: 'hi' },
    })

    // Today "does not exist" and "you may not touch it" are DIFFERENT strings —
    // exactly the existence-oracle shape §3.1.5 has to close later.
    expect(reply.ok).toBe(false)
    expect(reply.error).toBe('session not found')
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

  it(`${willChange('POD-1079', 'M5 requires unreachable to be DISTINGUISHABLE; today a send to an unreachable machine reports success')}: both send paths report ok/queued when the target's machine has gone away`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    o.reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    // The machine drops off: no daemon socket, so nothing can reach the PTY.
    o.reg.modules.sessions.detachDaemon('local')
    expect(o.meta(sessionId).status).toBe('reconnecting')
    o.daemon.length = 0

    const sent = await o.call.sessions.sendText({ sessionId, text: 'anyone there' })
    const woken = await o.call.sessions.resumeAndSend({ sessionId, text: 'anyone there' })

    // THIS IS THE BASELINE M5 HAS TO CHANGE: unreachable is reported as a
    // successful queue, indistinguishable from a busy-agent queue, and nothing
    // says the machine is gone. `unauthorized` has no shape at all yet.
    expect(sent).toEqual({ ok: true, queued: true, disposition: 'queued' })
    expect(woken).toEqual({ ok: true, queued: true, disposition: 'queued' })
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
