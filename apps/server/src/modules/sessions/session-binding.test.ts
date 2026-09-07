import { asMachineId, asSessionId } from '@podium/model'
import { expect, it, vi } from 'vitest'
import { Session } from './session'
import { SessionBindingReceipts, type SessionBindingReceiptsDeps } from './session-binding'

it('retains heuristic projection while the clearing write is pending and after it rejects', async () => {
  const machineId = asMachineId('binding-machine')
  const sessions = ['heuristic', 'exact'].map(
    (id) =>
      new Session({
        sessionId: asSessionId(id),
        durableLabel: id,
        agentKind: 'codex',
        cwd: '/project',
        title: id,
        origin: { kind: 'spawn' },
        createdAt: '2026-09-07T00:00:00.000Z',
        geometry: { cols: 80, rows: 24 },
        machineId,
        toDaemon: vi.fn(),
      }),
  )
  const [heuristic, exact] = sessions
  const write = vi.fn<SessionBindingReceiptsDeps['write']>(async (session, mutate) => {
    const draft = session.captureDurableState()
    mutate(draft)
    session.installDurableState(draft)
  })
  const receipts = new SessionBindingReceipts({
    memory: {
      ensureConversationIdentity: vi.fn(async () => 'conversation'),
      linkConversationSegment: vi.fn(async () => 'conversation'),
    },
    now: () => 0,
    sessions: () => sessions,
    session: (id) => sessions.find((session) => session.sessionId === id),
    sessionOwner: vi.fn(async () => undefined),
    write,
    broadcastSessions: vi.fn(),
    toMachine: vi.fn(),
  })
  const resume = { kind: 'codex-thread' as const, value: 'shared-thread' }
  await receipts.observeResumeRef(machineId, {
    type: 'sessionResumeRef',
    sessionId: heuristic.sessionId,
    resume,
    confidence: 'heuristic',
  })
  // Inspect the provenance itself: the durable resume alone stays unchanged even
  // with the regression, so an end-state resume assertion cannot guard this order.
  const projection = receipts['projectedConfidence']
  expect(projection.get(heuristic)).toBe('heuristic')
  const before = heuristic.captureDurableState()
  let entered!: () => void
  const writeEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  let rejectWrite!: (error: Error) => void
  const pendingWrite = new Promise<void>((_, reject) => {
    rejectWrite = reject
  })
  write.mockImplementationOnce(async (session, mutate) => {
    expect(session).toBe(heuristic)
    const draft = session.captureDurableState()
    mutate(draft)
    expect(draft.resume).toBeUndefined()
    expect(draft.conversationBinding).toBe('bound')
    entered()
    await pendingWrite
    session.installDurableState(draft)
  })
  const failure = new Error('clearing write rejected')
  const observation = receipts.observeResumeRef(machineId, {
    type: 'sessionResumeRef',
    sessionId: exact.sessionId,
    resume,
    confidence: 'exact',
  })
  const rejected = expect(observation).rejects.toBe(failure)
  await writeEntered
  try {
    expect(
      projection.get(heuristic),
      'heuristic projection must survive while the clearing write is pending',
    ).toBe('heuristic')
  } finally {
    rejectWrite(failure)
    await rejected
  }
  expect(
    projection.get(heuristic),
    'rejected clearing write must retain heuristic projection',
  ).toBe('heuristic')
  expect(heuristic.captureDurableState()).toEqual(before)
  expect(exact.resume).toBeUndefined()
})
