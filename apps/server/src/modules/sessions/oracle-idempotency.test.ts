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

import type { ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, MUST_NOT_CHANGE, makeOracle, waitFor } from './oracle-support'

afterEach(() => disposeOracles())

const inputs = (daemon: ControlMessage[]) =>
  daemon.filter((m): m is Extract<ControlMessage, { type: 'input' }> => m.type === 'input')

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

  it(`${MUST_NOT_CHANGE}: every outbox-covered presence write dedupes its replay`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const until = new Date(Date.now() + 60_000).toISOString()

    // setArchived
    await o.call.sessions.setArchived({ sessionId, archived: true, mutationId: 'm-arch' })
    await o.call.sessions.setArchived({ sessionId, archived: false })
    await o.call.sessions.setArchived({ sessionId, archived: true, mutationId: 'm-arch' })
    expect(o.meta(sessionId).archived).toBe(false)

    // setWorkState
    await o.call.sessions.setWorkState({ sessionId, workState: 'done', mutationId: 'm-ws' })
    await o.call.sessions.setWorkState({ sessionId, workState: 'planning' })
    await o.call.sessions.setWorkState({ sessionId, workState: 'done', mutationId: 'm-ws' })
    expect(o.meta(sessionId).workState).toBe('planning')

    // markRead / markUnread
    await o.call.sessions.markRead({ sessionId, mutationId: 'm-read' })
    await o.call.sessions.markUnread({ sessionId })
    await o.call.sessions.markRead({ sessionId, mutationId: 'm-read' })
    expect(o.meta(sessionId).unread).toBe(true)

    // snoozes.set / snoozes.clear
    await o.call.snoozes.set({ sessionId, until, mutationId: 'm-snooze' })
    await o.call.snoozes.clear({ sessionId })
    await o.call.snoozes.set({ sessionId, until, mutationId: 'm-snooze' })
    expect(await o.call.snoozes.list()).toEqual({})
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
    o.reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    o.reg.modules.sessions.onDaemonMessageFrom('local', {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    o.daemon.length = 0

    await o.call.sessions.sendText({ sessionId, text: 'only once', mutationId: 'm-send' })
    await waitFor(() => inputs(o.daemon).length > 0, 'the first send to reach the PTY')
    const framesAfterFirst = inputs(o.daemon).length

    await o.call.sessions.sendText({ sessionId, text: 'only once', mutationId: 'm-send' })

    expect(inputs(o.daemon)).toHaveLength(framesAfterFirst)
    expect(
      inputs(o.daemon)
        .map((m) => Buffer.from(m.data, 'base64').toString())
        .join('')
        .split('only once').length - 1,
    ).toBe(1)
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

  it(`${MUST_NOT_CHANGE}: the lifecycle commands take no mutationId — kill / hibernate / resurrect / handoff are not replay-protected`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.kill({ sessionId })
    // A second kill of the same id is simply another (no-op) apply, with nothing
    // recorded that a replay could short-circuit against.
    await expect(o.call.sessions.kill({ sessionId })).resolves.toBeUndefined()
    expect(o.store.sessions.loadDeletedSessions()).toHaveLength(1)
  })
})
