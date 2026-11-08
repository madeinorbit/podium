/**
 * The bridge's as-the-user session port (POD-6212): every verb runs under the
 * bound user's own principal through the session command plane, a refused gate
 * reads as "no such session", and a shared id prefix never names another
 * user's session. The command plane itself is mocked here — its gates have
 * their own suites; what is pinned is that the port asks it, as whom, and what
 * it does with the answer.
 */

import { asSessionId, asUserId, type SessionId } from '@podium/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistryModules } from '../../relay'
import type { SessionFacts } from '../sessions/facts'

const ctxFor = vi.hoisted(() => vi.fn())
const dispatch = vi.hoisted(() => vi.fn())
vi.mock('../sessions/command-ctx', () => ({ sessionCommandCtx: ctxFor }))
vi.mock('../sessions/command-plane', () => ({ dispatchSessionCommand: dispatch }))
vi.mock('../sessions/refs', () => ({
  readSessionRefs: async (_store: unknown, facts: SessionFacts[]) =>
    new Map(facts.filter((f) => f.refLetter).map((f) => [f.sessionId, `POD-1-${f.refLetter}`])),
}))

const { directSessionPort } = await import('./direct-session-port')

const ADA = asUserId('usr-ada')
const BOB = asUserId('usr-bob')
const MINE = asSessionId('abc11111-1111-4111-8111-111111111111')
const MINE_TOO = asSessionId('abc22222-2222-4222-8222-222222222222')
const THEIRS = asSessionId('abc33333-3333-4333-8333-333333333333')

const facts = (sessionId: SessionId, over: Partial<SessionFacts> = {}): SessionFacts =>
  ({
    sessionId,
    ownerUserId: ADA,
    agentKind: 'claude-code',
    cwd: '/p',
    machineId: 'm1',
    status: 'live',
    archived: false,
    headless: false,
    title: 'title',
    name: '',
    createdAt: '2026-10-17T00:00:00.000Z',
    lastActiveAt: '2026-10-17T00:00:00.000Z',
    busy: false,
    refIssueId: null,
    refLetter: null,
    refDraft: null,
    ...over,
  }) as SessionFacts

const rows = new Map<SessionId, SessionFacts>([
  [MINE, facts(MINE, { name: 'mine', refLetter: 'A', resume: { kind: 'claude', value: 'r' } as never })],
  [MINE_TOO, facts(MINE_TOO)],
  [THEIRS, facts(THEIRS, { ownerUserId: BOB })],
])

let resolveIdentifier: ReturnType<typeof vi.fn>
let readTranscript: ReturnType<typeof vi.fn>
let readSessionFactsWithStatuses: ReturnType<typeof vi.fn>
let target: ReturnType<typeof vi.fn>
let roles: Map<string, 'admin' | 'member'>

function port() {
  const modules = {
    readToolkit: { resolveIdentifier },
    sessions: {
      readSessionFactsById: async (id: SessionId) => rows.get(id),
      readSessionFactsByIds: async (ids: SessionId[]) => ids.flatMap((id) => rows.get(id) ?? []),
      readSessionFactsWithStatuses,
    },
    rpc: { readTranscript },
    machines: { hasDaemon: () => true },
  } as unknown as RegistryModules
  const store = { users: { roleOf: async (id: string) => roles.get(id) } } as never
  return directSessionPort(modules, store)
}

beforeEach(() => {
  resolveIdentifier = vi.fn()
  readTranscript = vi.fn(async () => ({ items: [{ id: 'i1', role: 'assistant', text: 'hi' }] }))
  readSessionFactsWithStatuses = vi.fn(async () => [...rows.values()])
  target = vi.fn(async (sessionId: SessionId) => ({ sessionId }))
  roles = new Map([
    [ADA, 'member'],
    [BOB, 'member'],
  ])
  ctxFor.mockReset()
  ctxFor.mockImplementation(async () => ({ target }))
  dispatch.mockReset()
})

describe('directSessionPort', () => {
  it('resolves an id through the read toolkit and the command gate, as the user', async () => {
    resolveIdentifier.mockResolvedValue({ kind: 'session', sessionId: MINE })
    const resolved = await port().resolve(ADA, ' POD-1-A ')

    expect(resolveIdentifier).toHaveBeenCalledWith('POD-1-A')
    expect(target).toHaveBeenCalledWith(MINE, 'sessions.sendText')
    const capability = ctxFor.mock.calls[0]![1]
    expect(capability).toMatchObject({ actorUser: ADA, onBehalfOf: ADA, scope: { kind: 'owned', userId: ADA } })
    expect(resolved).toEqual({
      kind: 'session',
      session: expect.objectContaining({
        sessionId: MINE,
        ownerUserId: ADA,
        label: 'mine',
        ref: 'POD-1-A',
        resumable: true,
      }),
    })
  })

  it('reads a refused gate as no session', async () => {
    resolveIdentifier.mockResolvedValue({ kind: 'session', sessionId: THEIRS })
    target.mockRejectedValue(new Error('forbidden'))
    expect(await port().resolve(ADA, THEIRS)).toEqual({ kind: 'absent' })
    expect(await port().describe(ADA, THEIRS)).toBeUndefined()
  })

  it('narrows an ambiguous prefix to the user’s own sessions before answering', async () => {
    resolveIdentifier.mockResolvedValue({
      kind: 'ambiguous',
      prefix: 'abc',
      candidates: [MINE, THEIRS],
      message: 'ambiguous',
    })
    expect(await port().resolve(ADA, 'abc')).toMatchObject({ kind: 'session', session: { sessionId: MINE } })

    resolveIdentifier.mockResolvedValue({
      kind: 'ambiguous',
      prefix: 'abc',
      candidates: [MINE, MINE_TOO, THEIRS],
      message: `ambiguous: ${THEIRS}`,
    })
    const ambiguous = await port().resolve(ADA, 'abc')
    expect(ambiguous.kind).toBe('ambiguous')
    expect(ambiguous.kind === 'ambiguous' && ambiguous.message).toContain(MINE_TOO)
    expect(ambiguous.kind === 'ambiguous' && ambiguous.message).not.toContain(THEIRS)

    resolveIdentifier.mockResolvedValue({ kind: 'ambiguous', prefix: 'abc', candidates: [THEIRS], message: 'x' })
    expect(await port().resolve(ADA, 'abc')).toEqual({ kind: 'absent' })
  })

  it('lists only the user’s own running, visible sessions', async () => {
    rows.set(asSessionId('hidden'), facts(asSessionId('hidden'), { headless: true }))
    const listed = await port().listRunning(ADA)
    rows.delete(asSessionId('hidden'))
    expect(readSessionFactsWithStatuses).toHaveBeenCalledWith(['live', 'starting'])
    expect(listed.map((s) => s.sessionId)).toEqual([MINE, MINE_TOO])
  })

  it('sends through sessions.sendText and reports what the plane answered', async () => {
    dispatch.mockResolvedValue({ ok: true, queued: true, position: 3, disposition: 'queued' })
    expect(await port().send(ADA, MINE, 'go')).toEqual({ ok: true, queued: true, position: 3 })
    expect(dispatch).toHaveBeenCalledWith({ target }, 'sendText', { sessionId: MINE, text: 'go' })
  })

  it('stops through sessions.interrupt and wakes only through sessions.resurrect', async () => {
    dispatch.mockResolvedValueOnce({ ok: false, reason: 'session not running' })
    expect(await port().interrupt(ADA, MINE)).toEqual({ ok: false, reason: 'session not running' })
    dispatch.mockResolvedValueOnce({ ok: true })
    expect(await port().wake(ADA, MINE)).toEqual({ ok: true })
    expect(dispatch.mock.calls.map((call) => call[1])).toEqual(['interrupt', 'resurrect'])
  })

  it('does nothing for an account that is no longer active', async () => {
    roles.delete(ADA)
    expect(await port().send(ADA, MINE, 'go')).toEqual({ ok: false, reason: 'your account is not active' })
    expect(await port().describe(ADA, MINE)).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reads the transcript as the user', async () => {
    expect(await port().readTail(ADA, MINE, 40)).toEqual([{ id: 'i1', role: 'assistant', text: 'hi' }])
    expect(readTranscript).toHaveBeenCalledWith(
      { sessionId: MINE, direction: 'before', limit: 40 },
      { kind: 'user', id: ADA },
    )
  })
})
