/**
 * A SESSION'S LIVE READINGS, AS TOPIC VALUES (POD-6764).
 *
 * The producers behind `session.terminalState` and `session.condition`: where a
 * value comes from (the terminal of a session this process runs, the row of one
 * it does not), and when a value is sent (a move of a live reading, once, only
 * for a held key).
 */
import { asMachineId, asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { ClientConn } from '../../gateway/client-registry'
import { testClientPrincipal } from '../../test-support/client-principal'
import { type SessionLiveKind, SessionLiveTopics, type StoredSessionLive } from './live-topics'
import { Session } from './session'

const ID = asSessionId('s1')

function shell(): Session {
  return new Session({
    ownerUserId: firstAdminMemberId(),
    sessionId: ID,
    durableLabel: 'podium-s1',
    agentKind: 'shell',
    cwd: '/w',
    title: 'w',
    origin: { kind: 'spawn' },
    createdAt: '2026-11-10T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: asMachineId('m1'),
    toDaemon: vi.fn(),
  })
}

function client(id: string): ClientConn {
  return {
    id,
    principal: testClientPrincipal(id),
    send: vi.fn(),
    sendStream: vi.fn(() => true),
    viewports: new Map(),
    attached: new Set(),
    caps: new Set(),
    wireVersion: 1,
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
  } as unknown as ClientConn
}

function fixture(options: { resident?: boolean; row?: StoredSessionLive } = {}) {
  const sessions = new Map<SessionId, Session>()
  const session = shell()
  if (options.resident !== false) sessions.set(ID, session)
  const sent: Array<{ kind: SessionLiveKind; value: unknown }> = []
  const stored = vi.fn(async () => options.row)
  const topics = new SessionLiveTopics({
    session: (id) => sessions.get(id),
    stored,
    publish: (kind, _id, value) => sent.push({ kind, value }),
  })
  // As the repository wires every resident session.
  session.terminal.setLiveListener(() => topics.changed(ID))
  return { sessions, session, sent, stored, topics }
}

describe('session live topics (POD-6764)', () => {
  it('a running session answers from its terminal, without reading the database', async () => {
    const { session, topics, stored } = fixture()
    const a = client('a')
    session.terminal.attachClient(a)
    session.terminal.applyDaemonGeometry({ cols: 132, rows: 43 })

    expect(await topics.snapshot('session.terminalState', ID)).toEqual({
      controller: 'a',
      controllerIdentity: expect.anything(),
      geometry: { cols: 132, rows: 43 },
    })
    expect(await topics.snapshot('session.condition', ID)).toEqual({
      busy: false,
      requestsGated: 0,
    })
    expect(stored).not.toHaveBeenCalled()
  })

  it('STORED GEOMETRY: a session no process holds the terminal of answers its stored size, with nobody in control', async () => {
    // The daemon is offline and this server does not run the session: the row
    // is all there is, and it is enough to show the cached terminal view at
    // the right size.
    const { topics, stored } = fixture({
      resident: false,
      row: {
        geometry: { cols: 132, rows: 43 },
        lastInputAt: '2026-11-09T10:00:00.000Z',
        status: 'hibernated',
        exitCode: null,
      },
    })
    expect(await topics.snapshot('session.terminalState', ID)).toEqual({
      controller: null,
      geometry: { cols: 132, rows: 43 },
    })
    expect(await topics.snapshot('session.condition', ID)).toEqual({
      busy: false,
      requestsGated: 0,
      lastInputAt: '2026-11-09T10:00:00.000Z',
    })
    expect(stored).toHaveBeenCalledTimes(2)
  })

  it('a stopped session states its exit; a session that is gone is unknown', async () => {
    const exited = fixture({
      resident: false,
      row: { geometry: { cols: 100, rows: 30 }, lastInputAt: null, status: 'exited', exitCode: 3 },
    })
    expect(await exited.topics.snapshot('session.terminalState', ID)).toEqual({
      controller: null,
      geometry: { cols: 100, rows: 30 },
      exit: { code: 3 },
    })
    const gone = fixture({ resident: false })
    expect(await gone.topics.snapshot('session.terminalState', ID)).toBeUndefined()
    expect(await gone.topics.snapshot('session.condition', ID)).toBeUndefined()
  })

  it('a session that became resident while its row was read answers from its terminal', async () => {
    const { sessions, session, topics } = fixture({
      resident: false,
      row: { geometry: { cols: 80, rows: 24 }, lastInputAt: null, status: 'live', exitCode: null },
    })
    const pending = topics.snapshot('session.terminalState', ID)
    session.terminal.applyDaemonGeometry({ cols: 150, rows: 50 })
    sessions.set(ID, session)
    expect(await pending).toMatchObject({ geometry: { cols: 150, rows: 50 } })
  })

  it('publishes a move of a live reading once, and only for a held key', () => {
    const { session, topics, sent } = fixture()
    session.terminal.applyDaemonGeometry({ cols: 90, rows: 30 })
    expect(sent).toEqual([])

    topics.start('session.terminalState', ID)
    void topics.snapshot('session.terminalState', ID)
    session.terminal.applyDaemonGeometry({ cols: 100, rows: 40 })
    expect(sent).toEqual([
      {
        kind: 'session.terminalState',
        value: { controller: null, geometry: { cols: 100, rows: 40 } },
      },
    ])
    // The same size again is no change; a recheck with nothing moved sends nothing.
    session.terminal.applyDaemonGeometry({ cols: 100, rows: 40 })
    topics.recheckNow()
    expect(sent).toHaveLength(1)

    topics.stop('session.terminalState', ID)
    session.terminal.applyDaemonGeometry({ cols: 110, rows: 41 })
    expect(sent).toHaveLength(1)
  })

  it('control changes reach the terminal state; busy and context use reach the condition', () => {
    const { session, topics, sent } = fixture()
    for (const kind of ['session.terminalState', 'session.condition'] as const) {
      topics.start(kind, ID)
      void topics.snapshot(kind, ID)
    }
    const a = client('a')
    session.terminal.attachClient(a)
    expect(sent.at(-1)).toMatchObject({
      kind: 'session.terminalState',
      value: { controller: 'a' },
    })

    // Submitting a line starts a command: the shell is busy.
    session.terminal.handleInput('a', Buffer.from('ls\r').toString('base64'))
    const busy = sent.filter((s) => s.kind === 'session.condition').at(-1)
    expect(busy?.value).toMatchObject({ busy: true })
    expect((busy?.value as { lastInputAt?: string }).lastInputAt).toEqual(expect.any(String))

    // A context reading is not the terminal's: the session broadcast rechecks.
    session.setContextUsagePercent(42)
    topics.recheckNow()
    expect(sent.filter((s) => s.kind === 'session.condition').at(-1)?.value).toMatchObject({
      contextUsagePercent: 42,
    })
  })

  it('a session that leaves the map keeps its stored facts and drops what needed the process', () => {
    const { sessions, session, topics, sent } = fixture()
    for (const kind of ['session.terminalState', 'session.condition'] as const) {
      topics.start(kind, ID)
      void topics.snapshot(kind, ID)
    }
    session.terminal.attachClient(client('a'))
    session.terminal.applyDaemonGeometry({ cols: 120, rows: 40 })
    session.terminal.handleInput('a', Buffer.from('ls\r').toString('base64'))
    sent.length = 0

    sessions.delete(ID)
    topics.recheckNow()
    expect(sent.find((s) => s.kind === 'session.terminalState')?.value).toEqual({
      controller: null,
      geometry: { cols: 120, rows: 40 },
    })
    expect(sent.find((s) => s.kind === 'session.condition')?.value).toMatchObject({
      busy: false,
      requestsGated: 0,
    })
  })
})
