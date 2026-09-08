import { asMachineId, asSessionId, type MachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { Session } from './session'
import type { HandoffPorts } from './handoff/ports'
import { HandoffTransfer, type HandoffTransferPorts } from './handoff/transfer'
import type { HandoffPlacement } from './handoff/placement'
import type { HandoffPreflightResult } from './handoff/preflight'
import type { SessionRepository } from './repository'
import { SessionRevival, type SessionRevivalPorts } from './session-revival'
import { SessionTeardown, type SessionTeardownPorts } from './session-teardown'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const session = new Session({
    sessionId: asSessionId('durable-order'),
    durableLabel: 'podium-durable-order',
    agentKind: 'claude-code',
    cwd: '/source',
    title: 'Durable ordering',
    origin: { kind: 'spawn' },
    createdAt: '2026-09-08T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: asMachineId('machine'),
    toDaemon: () => {},
  })
  session.status = 'live'
  session.resume = { kind: 'claude-session', value: 'conversation' }
  const events: string[] = []
  const entered = deferred()
  const commit = deferred()
  const repository: Pick<SessionRepository, 'write'> = {
    async write(subject, mutate) {
      const draft = subject.captureDurableState()
      mutate(draft)
      entered.resolve()
      await commit.promise
      subject.restoreDurableState(draft)
      events.push('commit')
    },
  }
  return { session, events, entered, commit, repository }
}

describe('durable session write ordering', () => {
  it('requires a promise from the handoff durable write port', () => {
    type RequiresPromise<T extends Promise<void>> = T
    const committed: RequiresPromise<ReturnType<HandoffPorts['write']>> = Promise.resolve()
    expect(committed).toBeInstanceOf(Promise)
  })
  it('hibernate commits parked state before kill and successful return', async () => {
    const f = fixture()
    const teardown = new SessionTeardown({
      sessions: new Map([[f.session.sessionId, f.session]]),
      repository: f.repository,
      now: () => 0,
      autoContinue: { onSessionGone() {} },
      toMachine: () => { f.events.push(`kill:${f.session.status}`) },
      broadcastSessions() {},
    } as unknown as SessionTeardownPorts)
    const pending = teardown.hibernateSession({ sessionId: f.session.sessionId })
      .then(result => { f.events.push(`return:${f.session.status}`); return result })
    await f.entered.promise
    f.commit.resolve()
    expect(await pending).toEqual({ ok: true })
    expect(f.events).toEqual(['commit', 'kill:hibernated', 'return:hibernated'])
  })

  it('handoff rechecks grants after parking and restores an un-killed source on revocation', async () => {
    const f = fixture()
    let revoked = false
    const transfer = new HandoffTransfer({
      write: f.repository.write,
      onSessionGone() {},
      broadcastSessions() {},
      toMachine: () => { f.events.push('kill') },
    } as unknown as HandoffTransferPorts)
    const pending = transfer.apply(
      { session: f.session } as HandoffPlacement,
      {} as HandoffPreflightResult,
      { sessionId: f.session.sessionId, machineId: asMachineId('target') },
      {} as Parameters<HandoffTransfer['apply']>[3],
      () => { if (revoked) throw new Error('machine grant revoked') },
    )
    await f.entered.promise
    revoked = true
    f.commit.resolve()
    await expect(pending).rejects.toThrow('machine grant revoked')
    expect(f.session.status).toBe('live')
    expect(f.events).toEqual(['commit', 'commit'])
  })

  function revival(f: ReturnType<typeof fixture>) {
    return new SessionRevival({
      repository: f.repository,
      instructionsForStart: async () => ({ instructions: [], commit: async () => {} }),
      terminalProof: { fence: async () => { f.events.push(`fence:${f.session.status}`) } },
      toMachine: (_machine: MachineId, message: ControlMessage) => {
        if (message.type === 'spawn') f.events.push(`spawn:${message.cwd}`)
      },
      launchConfig: { modelDefaults: async () => ({}), accountEnv: async () => ({}) },
      state: { draftSyncEnabled: () => false },
      broadcastSessions() {},
    } as unknown as SessionRevivalPorts)
  }

  it('revival commits starting state and cwd before fence and spawn', async () => {
    const f = fixture()
    f.session.status = 'hibernated'
    const pending = revival(f).finishResurrect(f.session, { ok: true, cwd: '/target' })
    await f.entered.promise
    f.commit.resolve()
    expect(await pending).toEqual({ ok: true })
    expect(f.events).toEqual(['commit', 'fence:starting', 'spawn:/target'])
  })

  it('revival refuses a session archived while its commit was pending', async () => {
    const f = fixture()
    f.session.status = 'hibernated'
    // Retirement is visible when the write completes, before the continuation.
    const write = f.repository.write
    f.repository.write = async (...args) => {
      await write(...args)
      f.session.archived = true
    }
    const pending = revival(f).finishResurrect(f.session, { ok: true, cwd: '/target' })
    await f.entered.promise
    f.commit.resolve()
    expect(await pending).toEqual({ ok: false, reason: 'session is archived' })
    expect(f.events).toEqual(['commit'])
  })
})
