import { firstAdminMemberId } from '@podium/model'
import { asMachineId, asSessionId } from '@podium/model'
import { expect, it, vi } from 'vitest'
import { Session } from './session'
import { SessionBindingReceipts, type SessionBindingReceiptsDeps } from './session-binding'

type MemoryPort = SessionBindingReceiptsDeps['memory']
/** Derived rather than imported: if the registry's id type changes, this breaks. */
type ConversationId = Awaited<ReturnType<MemoryPort['ensureConversationIdentity']>>

it('retains heuristic projection while the clearing write is pending and after it rejects', async () => {
  const machineId = asMachineId('binding-machine')
  const sessions = ['heuristic', 'exact'].map(
    (id) =>
      new Session({
    ownerUserId: firstAdminMemberId(),
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
  // `sessions` is built directly above with exactly these two entries, so the
// indexed reads are total; the assertions make that total-ness checkable
// rather than asserted with a bare non-null operator.
const heuristic = sessions[0]
const exact = sessions[1]
if (!heuristic || !exact) throw new Error('fixture must build both sessions')
  const write = vi.fn<SessionBindingReceiptsDeps['write']>(async (session, mutate) => {
    const draft = session.captureDurableState()
    mutate(draft)
    session.installDurableState(draft)
  })
  const receipts = new SessionBindingReceipts({
    memory: {
      ensureConversationIdentity: vi.fn<MemoryPort['ensureConversationIdentity']>(
        async () => 'conversation' as ConversationId,
      ),
      linkConversationSegment: vi.fn<MemoryPort['linkConversationSegment']>(
        async () => 'conversation' as ConversationId,
      ),
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


it('acknowledges a fenced native receipt only after persistence, and retries a failed write', async () => {
  const owner = firstAdminMemberId()
  const machineId = asMachineId('receipt-machine')
  const session = new Session({ ownerUserId: owner, sessionId: asSessionId('receipt'),
    durableLabel: 'receipt', agentKind: 'codex', cwd: '/project', title: 'receipt',
    origin: { kind: 'spawn' }, createdAt: '2026-09-18T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 }, machineId, toDaemon: vi.fn() })
  const toMachine = vi.fn()
  let fail = true
  const write = vi.fn<SessionBindingReceiptsDeps['write']>(async (target, mutate) => {
    if (fail) throw new Error('disk failed')
    const draft = target.captureDurableState()
    mutate(draft)
    target.installDurableState(draft)
  })
  const receipts = new SessionBindingReceipts({
    memory: {
      ensureConversationIdentity: async () => 'conversation' as ConversationId,
      linkConversationSegment: async () => 'conversation' as ConversationId,
    }, now: () => 0, sessions: () => [session], session: () => session,
    sessionOwner: async () => ({ owner, grants: [] }), write, toMachine, broadcastSessions: vi.fn(),
  })
  const receipt = { id: 'native-receipt', ownerId: owner, attemptId: 'attempt', observerGeneration: 1 }
  const message = { type: 'sessionResumeRef' as const, sessionId: session.sessionId,
    resume: { kind: 'codex-thread', value: 'native' }, confidence: 'exact' as const,
    ackRequested: true, receipt }
  await expect(receipts.observeResumeRef(machineId, message)).rejects.toThrow('disk failed')
  expect(toMachine).not.toHaveBeenCalled()
  expect(session.resume).toBeUndefined()
  fail = false
  await receipts.observeResumeRef(machineId, message)
  await receipts.observeResumeRef(machineId, message)
  expect(session.resume).toEqual(message.resume)
  expect(toMachine).toHaveBeenCalledTimes(2)
  expect(toMachine).toHaveBeenLastCalledWith(machineId, {
    type: 'sessionResumeRefAck', sessionId: session.sessionId, resume: message.resume, ownerId: owner, receipt,
  })
  await receipts.observeResumeRef(asMachineId('foreign'), { ...message, resume: { kind: 'codex-thread', value: 'foreign' } })
  expect(session.resume).toEqual(message.resume)
})
