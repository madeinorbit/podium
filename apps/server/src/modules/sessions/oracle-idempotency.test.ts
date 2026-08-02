/**
 * ORACLE — idempotent replay and offline queueing (POD-379 for POD-312).
 *
 * The client outbox (docs/spec/outbox-write-path.md) replays a queued mutation
 * with a STABLE mutationId after a reload or a reconnect, so the server-side
 * dedup is what makes an offline write safe. This file pins that dedup for
 * every write that carries a mutationId today, and pins the ABSENCE of it for
 * the writes that do not.
 *
 * Correction to the issue brief worth recording: offline queueing is NOT
 * issue-writes-only today. `createEngineOutbox`
 * (packages/client-core/src/engine/wiring.ts) covers session rename,
 * setArchived, setWorkState, snoozeSet, snoozeClear, markRead, markUnread and
 * resumeAndSend alongside the three issue kinds; pins, tab order and sendText
 * stay DIRECT by explicit decision. The client half of that set is
 * characterized in packages/client-core/src/engine/outbox-coverage.oracle.test.ts;
 * this file characterizes the server behaviour those replays depend on.
 */

import { asSessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  disposeOracles,
  MUST_NOT_CHANGE,
  makeOracle,
  PASTE_END,
  PASTE_START,
  ptyFrames,
  waitFor,
} from './oracle-support'

afterEach(() => disposeOracles())

/** Bind a claude-code session live and idle so a send lands immediately. */
function goIdle(o: ReturnType<typeof makeOracle>, sessionId: string): void {
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId: asSessionId(sessionId),
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId: asSessionId(sessionId),
    state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
  })
}

describe('oracle: mutationId dedup (what makes an outbox replay safe)', () => {
  it(`${MUST_NOT_CHANGE}: a replayed rename does NOT re-apply — a later value stands`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.rename({ sessionId, name: 'queued offline', mutationId: 'm-rename' })
    await o.call.sessions.rename({ sessionId, name: 'typed later' })
    await o.call.sessions.rename({ sessionId, name: 'queued offline', mutationId: 'm-rename' })

    expect(o.meta(sessionId).name).toBe('typed later')
  })

  it(`${MUST_NOT_CHANGE}: replay is keyed on the mutationId alone — a DIFFERENT id re-applies the same input`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.rename({ sessionId, name: 'from the queue', mutationId: 'm-a' })
    await o.call.sessions.rename({ sessionId, name: 'typed later' })
    await o.call.sessions.rename({ sessionId, name: 'from the queue', mutationId: 'm-b' })

    expect(o.meta(sessionId).name).toBe('from the queue')
  })

  it(`${MUST_NOT_CHANGE}: omitting the mutationId means NO dedup at all`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.rename({ sessionId, name: 'first' })
    await o.call.sessions.rename({ sessionId, name: 'second' })
    await o.call.sessions.rename({ sessionId, name: 'first' })

    expect(o.meta(sessionId).name).toBe('first')
    expect(o.store.sync.getAppliedMutation('')).toBeUndefined()
  })

  // ONE TEST PER MUTATION-BEARING ROUTE. Deliberately not table-driven and
  // deliberately not folded into one omnibus: the cutover's realistic failure is
  // omitting the withMutation wrapper on ONE route, and that must red exactly the
  // test named for that route rather than hiding behind a generic dedup case.

  it(`${MUST_NOT_CHANGE}: sessions.setArchived dedupes its replay`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.setArchived({ sessionId, archived: true, mutationId: 'm-arch' })
    await o.call.sessions.setArchived({ sessionId, archived: false })
    await o.call.sessions.setArchived({ sessionId, archived: true, mutationId: 'm-arch' })

    expect(o.meta(sessionId).archived).toBe(false)
    expect(o.store.sync.getAppliedMutation('m-arch')).toBeDefined()
  })

  it(`${MUST_NOT_CHANGE}: sessions.setWorkState dedupes its replay`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.setWorkState({ sessionId, workState: 'done', mutationId: 'm-ws' })
    await o.call.sessions.setWorkState({ sessionId, workState: 'planning' })
    await o.call.sessions.setWorkState({ sessionId, workState: 'done', mutationId: 'm-ws' })

    expect(o.meta(sessionId).workState).toBe('planning')
    expect(o.store.sync.getAppliedMutation('m-ws')).toBeDefined()
  })

  it(`${MUST_NOT_CHANGE}: sessions.markRead dedupes its replay`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.markRead({ sessionId, mutationId: 'm-read' })
    await o.call.sessions.markUnread({ sessionId })
    await o.call.sessions.markRead({ sessionId, mutationId: 'm-read' })

    expect(o.meta(sessionId)).toMatchObject({ readAt: null, unread: true })
    expect(o.store.sync.getAppliedMutation('m-read')).toBeDefined()
  })

  it(`${MUST_NOT_CHANGE}: sessions.markUnread dedupes its replay`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.markRead({ sessionId })
    await o.call.sessions.markUnread({ sessionId, mutationId: 'm-unread' })
    await o.call.sessions.markRead({ sessionId })
    await o.call.sessions.markUnread({ sessionId, mutationId: 'm-unread' })

    // The replay must NOT clear the readAt the later markRead stamped.
    expect(o.meta(sessionId).unread).toBe(false)
    expect(o.meta(sessionId).readAt).not.toBeNull()
    expect(o.store.sync.getAppliedMutation('m-unread')).toBeDefined()
  })

  it(`${MUST_NOT_CHANGE}: sessions.setIssueId dedupes its replay`, async () => {
    const o = makeOracle()
    const issue = o.reg.issues.create({ repoPath: '/p', title: 'target', startNow: false })
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.setIssueId({ sessionId, issueId: issue.id, mutationId: 'm-issue' })
    await o.call.sessions.setIssueId({ sessionId, issueId: null })
    await o.call.sessions.setIssueId({ sessionId, issueId: issue.id, mutationId: 'm-issue' })

    // The replay must not re-attach a session the user has since detached.
    expect(o.meta(sessionId).issueId).toBeUndefined()
    expect(o.store.sync.getAppliedMutation('m-issue')).toBeDefined()
  })

  it(`${MUST_NOT_CHANGE}: snoozes.set dedupes its replay`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const until = new Date(Date.now() + 60_000).toISOString()

    await o.call.snoozes.set({ sessionId, until, mutationId: 'm-snooze' })
    await o.call.snoozes.clear({ sessionId })
    await o.call.snoozes.set({ sessionId, until, mutationId: 'm-snooze' })

    expect(await o.call.snoozes.list()).toEqual({})
    expect(o.store.sync.getAppliedMutation('m-snooze')).toBeDefined()
  })

  it(`${MUST_NOT_CHANGE}: snoozes.clear dedupes its replay`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const until = new Date(Date.now() + 60_000).toISOString()

    await o.call.snoozes.set({ sessionId, until })
    await o.call.snoozes.clear({ sessionId, mutationId: 'm-unsnooze' })
    await o.call.snoozes.set({ sessionId, until })
    await o.call.snoozes.clear({ sessionId, mutationId: 'm-unsnooze' })

    // The replay must not un-snooze a session the user has since re-snoozed.
    expect(await o.call.snoozes.list()).toEqual({ [sessionId]: until })
    expect(o.store.sync.getAppliedMutation('m-unsnooze')).toBeDefined()
  })

  it(`${MUST_NOT_CHANGE}: sessions.resumeAndSend dedupes its replay — a woken session is not messaged twice`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goIdle(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.resumeAndSend({ sessionId, text: 'wake once', mutationId: 'm-wake' })
    await waitFor(() => ptyFrames(o.daemon).length > 0, 'the first wake send to reach the PTY')
    const afterFirst = ptyFrames(o.daemon)

    await o.call.sessions.resumeAndSend({ sessionId, text: 'wake once', mutationId: 'm-wake' })

    expect(ptyFrames(o.daemon)).toEqual(afterFirst)
    expect(o.store.sync.getAppliedMutation('m-wake')).toBeDefined()
  })

  /**
   * THE DUPLICATE-DELIVERY TEST (POD-729's acceptance criterion).
   *
   * `sendText` and `resumeAndSend` no longer carry a hand-written
   * `withMutation` wrapper — idempotency is the framework envelope's, applied
   * once in `dispatchSessionCommand`. That is a claim about behaviour, so it is
   * asserted against behaviour: the same mutationId replayed must put NO second
   * frame on the PTY. Asserting it by reading the source would be exactly the
   * inspection the criterion rules out.
   *
   * Note the counterfactual in the second half. Without it, a fixture where the
   * FIRST send never reached the PTY would pass this test just as happily as a
   * working dedup — two empty frame lists compare equal.
   */
  it(`${MUST_NOT_CHANGE}: sessions.sendText dedupes its replay — the framework envelope, with no wrapper of its own`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    goIdle(o, sessionId)
    o.daemon.length = 0

    await o.call.sessions.sendText({ sessionId, text: 'run it once', mutationId: 'm-send' })
    await waitFor(() => ptyFrames(o.daemon).length > 0, 'the first chat send to reach the PTY')
    const afterFirst = ptyFrames(o.daemon)
    // The instrument can say YES: something actually got delivered.
    expect(afterFirst.length).toBeGreaterThan(0)

    await o.call.sessions.sendText({ sessionId, text: 'run it once', mutationId: 'm-send' })

    expect(ptyFrames(o.daemon)).toEqual(afterFirst)
    expect(o.store.sync.getAppliedMutation('m-send')).toBeDefined()

    // THE COUNTERFACTUAL: a DIFFERENT mutationId is a different write and must
    // deliver again. Without this the assertion above would also hold for a
    // server that had simply stopped sending.
    await o.call.sessions.sendText({ sessionId, text: 'run it twice', mutationId: 'm-send-2' })
    await waitFor(
      () => ptyFrames(o.daemon).length > afterFirst.length,
      'the second, distinctly-keyed send to reach the PTY',
    )
    expect(ptyFrames(o.daemon).length).toBeGreaterThan(afterFirst.length)
  })

  it(`${MUST_NOT_CHANGE}: a replay returns the value RECORDED at first apply, not a fresh read`, async () => {
    const o = makeOracle()
    const a = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const b = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    const first = await o.call.snoozes.set({
      sessionId: a.sessionId,
      until: null,
      mutationId: 'm-snapshot',
    })
    // The world moves on: a second session is snoozed too.
    await o.call.snoozes.set({ sessionId: b.sessionId, until: null })

    const replayed = await o.call.snoozes.set({
      sessionId: a.sessionId,
      until: null,
      mutationId: 'm-snapshot',
    })

    // The replay hands back the STALE recorded snapshot, not today's map.
    expect(replayed).toEqual(first)
    expect(replayed).not.toEqual(await o.call.snoozes.list())
  })

  it(`${MUST_NOT_CHANGE}: a replayed send does not double-type into the PTY`, async () => {
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
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    o.daemon.length = 0

    await o.call.sessions.sendText({ sessionId, text: 'only once', mutationId: 'm-send' })
    await waitFor(() => ptyFrames(o.daemon).length > 0, 'the first send to reach the PTY')

    await o.call.sessions.sendText({ sessionId, text: 'only once', mutationId: 'm-send' })

    // EXACT frame sequence: one frame, once. Counting substring occurrences in a
    // joined blob would miss a re-wrapped or re-split second delivery.
    expect(ptyFrames(o.daemon)).toEqual([
      { inputOrigin: 'mail', data: `${PASTE_START}only once${PASTE_END}` },
    ])
  })

  it(`${MUST_NOT_CHANGE}: an ASYNC proc records its RESOLVED value — a replayed create returns the same id and spawns once`, async () => {
    const o = makeOracle()

    const first = await o.call.sessions.create({
      agentKind: 'shell',
      cwd: '/p',
      mutationId: 'm-create',
    })
    const replay = await o.call.sessions.create({
      agentKind: 'shell',
      cwd: '/p',
      mutationId: 'm-create',
    })

    expect(replay.sessionId).toBe(first.sessionId)
    expect(o.daemon.filter((m) => m.type === 'spawn')).toHaveLength(1)
    expect(o.reg.modules.sessions.listSessions()).toHaveLength(1)
    // Recorded durably, so the replay survives a server restart too.
    expect(JSON.parse(o.store.sync.getAppliedMutation('m-create') as string)).toMatchObject({
      sessionId: first.sessionId,
    })
  })
})

describe('oracle: the writes with NO replay protection', () => {
  it(`${MUST_NOT_CHANGE}: pins and tab order take no mutationId, so a replayed toggle applies again`, async () => {
    const o = makeOracle()

    // The input schema has no mutationId field; tRPC strips the unknown key, so
    // nothing is recorded and the second call is a fresh apply.
    await o.call.pins.set({ kind: 'panel', id: 'p1', pinned: true })
    await o.call.pins.set({ kind: 'panel', id: 'p1', pinned: false })
    const afterReplay = await o.call.pins.set({ kind: 'panel', id: 'p1', pinned: true })

    expect(afterReplay.panels).toEqual(['p1'])
    expect(o.store.sync.getAppliedMutation('m-pin')).toBeUndefined()
  })

  it(`${MUST_NOT_CHANGE}: the lifecycle commands take no mutationId — kill, hibernate, resurrect and handoff each record NOTHING to replay against`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    // The name says four commands, so all four are exercised. tRPC strips the
    // unknown key, so the call succeeds and nothing is recorded — which is the
    // characterization: these routes have no replay protection to lose.
    const ids = {
      kill: 'm-kill',
      hibernate: 'm-hibernate',
      resurrect: 'm-resurrect',
      handoff: 'm-handoff',
    }
    await o.call.sessions.hibernate({ sessionId, mutationId: ids.hibernate } as never)
    await o.call.sessions.resurrect({ sessionId, mutationId: ids.resurrect } as never)
    await o.call.sessions
      .handoff({ sessionId, machineId: 'nowhere', mutationId: ids.handoff } as never)
      .catch(() => undefined)
    await o.call.sessions.kill({ sessionId, mutationId: ids.kill } as never)

    for (const id of Object.values(ids)) {
      expect(o.store.sync.getAppliedMutation(id)).toBeUndefined()
    }
    // And a second kill is simply another (no-op) apply, not a deduped replay.
    await expect(o.call.sessions.kill({ sessionId })).resolves.toBeUndefined()
    expect(o.store.sessions.loadDeletedSessions()).toHaveLength(1)
  })
})
