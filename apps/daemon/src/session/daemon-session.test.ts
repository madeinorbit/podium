import type { AbandonedQueuedTurn } from '@podium/harness/driver/host'
import { EngineBindUnrecoverable } from '@podium/harness/driver/host'
import type { SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { DaemonSession } from './daemon-session.js'

const SESSION_ID = 'bind-failure-session' as SessionId

function launchFailure(): EngineBindUnrecoverable {
  return new EngineBindUnrecoverable(
    SESSION_ID,
    'launch',
    'http://127.0.0.1:41234',
    new Error('opencode serve did not answer /health'),
    's3cret',
  )
}

function adoptFailure(): EngineBindUnrecoverable {
  return new EngineBindUnrecoverable(
    SESSION_ID,
    'adopt',
    'unix:///tmp/kept-engine.sock',
    new Error('listener silent'),
  )
}

function queuedTurn(id: string | undefined): AbandonedQueuedTurn {
  return {
    input: { ...(id ? { id } : {}), text: `nudge ${id ?? 'anonymous'}` },
    options: { origin: 'steward', delivery: 'when-ready' },
  }
}

describe('DaemonSession.bindFailed (§4.8 kept engine)', () => {
  it('a fresh bind failure with a prior queue invalidates its turns and surfaces spawnError', () => {
    const session = new DaemonSession({ sessionId: SESSION_ID })
    const sent: DaemonMessage[] = []
    const report = session.bindFailed(launchFailure(), {
      abandoned: { turns: [queuedTurn('turn-a'), queuedTurn('turn-b')], reason: 'never-live' },
      family: 'opencode',
    }, { send: (msg) => sent.push(msg) })

    expect(report).toEqual({ surfaced: true, abandonmentReported: true, engineRecorded: true })
    expect(sent).toContainEqual({
      type: 'runtimeQueueDrainAbandoned',
      reportId: expect.any(String),
      sessionId: SESSION_ID,
      turnIds: ['turn-a', 'turn-b'],
      reason: 'never-live',
    })
    const failure = sent.find((msg) => msg.type === 'spawnError')
    expect(failure).toMatchObject({ type: 'spawnError', sessionId: SESSION_ID })
    expect((failure as { message: string }).message).toContain('did not bind during launch')
    expect((failure as { message: string }).message).toContain('http://127.0.0.1:41234')
    // The credential rides the record, never the wire.
    expect(JSON.stringify(sent)).not.toContain('s3cret')
    expect(session.keptEngine).toMatchObject({
      address: 'http://127.0.0.1:41234',
      during: 'launch',
      secret: 's3cret',
    })
    expect(session.keptEngine?.at).toEqual(expect.any(String))
  })

  it('an adopt bind failure surfaces reattachFailed, never spawnError', () => {
    const session = new DaemonSession({ sessionId: SESSION_ID })
    const sent: DaemonMessage[] = []
    const report = session.bindFailed(adoptFailure(), {
      abandoned: { turns: [queuedTurn('turn-in-flight')], reason: 'delivery-failed' },
      family: 'codex',
    }, { send: (msg) => sent.push(msg) })

    expect(report).toEqual({ surfaced: true, abandonmentReported: true, engineRecorded: true })
    expect(sent).toContainEqual({
      type: 'runtimeQueueDrainAbandoned',
      reportId: expect.any(String),
      sessionId: SESSION_ID,
      turnIds: ['turn-in-flight'],
      reason: 'delivery-failed',
    })
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'reattachFailed', sessionId: SESSION_ID }),
    )
    expect(sent.some((msg) => msg.type === 'spawnError')).toBe(false)
    expect(session.keptEngine).toMatchObject({
      address: 'unix:///tmp/kept-engine.sock',
      during: 'adopt',
    })
  })

  it('id-less turns are logged but not framed, like the families own helper', () => {
    const session = new DaemonSession({ sessionId: SESSION_ID })
    const sent: DaemonMessage[] = []
    const report = session.bindFailed(launchFailure(), {
      abandoned: { turns: [queuedTurn(undefined), queuedTurn('turn-real')], reason: 'teardown' },
      family: 'opencode',
    }, { send: (msg) => sent.push(msg) })

    expect(report.abandonmentReported).toBe(true)
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'runtimeQueueDrainAbandoned',
        turnIds: ['turn-real'],
      }),
    )
  })

  it('no prior queue means no abandonment frame: the failure still surfaces and the engine is still recorded', () => {
    const session = new DaemonSession({ sessionId: SESSION_ID })
    const sent: DaemonMessage[] = []
    // The cold-launch shape: no driver ever existed, this daemon took custody
    // of nothing, and a frame naming nothing would correct nothing.
    const report = session.bindFailed(launchFailure(), { family: 'opencode' }, {
      send: (msg) => sent.push(msg),
    })

    expect(report).toEqual({ surfaced: true, abandonmentReported: false, engineRecorded: true })
    expect(sent.some((msg) => msg.type === 'runtimeQueueDrainAbandoned')).toBe(false)
    expect(sent.some((msg) => msg.type === 'spawnError')).toBe(true)
    expect(session.keptEngine?.address).toBe('http://127.0.0.1:41234')
  })

  it('a failure naming no address records nothing but still surfaces', () => {
    const session = new DaemonSession({ sessionId: SESSION_ID })
    const sent: DaemonMessage[] = []
    const error = new EngineBindUnrecoverable(SESSION_ID, 'launch', undefined, new Error('gone'))
    const report = session.bindFailed(error, { family: 'grok' }, {
      send: (msg) => sent.push(msg),
    })

    expect(report).toEqual({ surfaced: true, abandonmentReported: false, engineRecorded: false })
    expect(session.keptEngine).toBeUndefined()
    expect(sent).toContainEqual(expect.objectContaining({ type: 'spawnError' }))
  })

  it('clear() forgets the kept engine with the rest of the per-session state', () => {
    const session = new DaemonSession({ sessionId: SESSION_ID })
    const sent: DaemonMessage[] = []
    session.bindFailed(launchFailure(), { family: 'opencode' }, {
      send: (msg) => sent.push(msg),
    })
    expect(session.keptEngine).toBeDefined()
    session.clear()
    expect(session.keptEngine).toBeUndefined()
  })
})
