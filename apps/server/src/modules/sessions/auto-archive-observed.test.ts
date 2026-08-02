/**
 * The APPLY side of stopped-session auto-archive (POD-1229).
 *
 * `tryAutoArchiveStoppedObserved` is the session half of the janitor's
 * proposal→authority seam, and like its issue twin it was reachable in the suite
 * only through a `vi.fn()` mock in `modules/maintenance/service.test.ts`. A mock
 * that returns 'applied' cannot fail when the revalidation is wrong, so the
 * decision this method makes — WHOSE read may retire a session from a shared
 * board — had no coverage at all.
 *
 * POD-1210 chose the reader (the viewer the shared `archived` flag speaks for)
 * but the wire never said so: janitor and server each supplied the reader from
 * their own copy of `FIRST_ADMIN_USER_ID`, so a disagreement between them was
 * unrepresentable and therefore untestable. The observation now names its
 * reader and this method refuses any other. These tests are what fails if that
 * refusal is removed.
 */

import { asUserId, FIRST_ADMIN_USER_ID, type SessionId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'

const DAY_MS = 24 * 60 * 60 * 1000
const registries: SessionRegistry[] = []

afterEach(() => {
  for (const r of registries.splice(0)) r.dispose()
})

/** A stopped session the broadcast viewer has read — the archivable fixture. */
async function stoppedAndRead(): Promise<{
  reg: SessionRegistry
  sessionId: SessionId
  stoppedMs: number
}> {
  const reg = new SessionRegistry()
  registries.push(reg)
  const { sessionId } = reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/r' })
  await reg.modules.issueSessionLifecycle.stopSession({ sessionId })
  // Read AFTER the stop: `readAt >= stoppedAt` is one of the preconditions, so a
  // fixture read before stopping would fail for a reason these tests do not name.
  reg.modules.sessions.markSessionRead(FIRST_ADMIN_USER_ID, sessionId)
  const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
  return { reg, sessionId, stoppedMs: Date.parse(meta?.stoppedAt ?? '') }
}

const observation = (sessionId: SessionId, readerUserId: string) => ({
  sessionId,
  issueId: null,
  stoppedAt: '',
  readerUserId,
  archived: false as const,
})

describe('SessionService.tryAutoArchiveStoppedObserved — whose read (POD-1229)', () => {
  it('APPLIES an observation naming the viewer it archives for', async () => {
    // Says YES first, on the same fixture every refusal below uses.
    const { reg, sessionId, stoppedMs } = await stoppedAndRead()
    const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(
      reg.modules.sessions.tryAutoArchiveStoppedObserved(
        { ...observation(sessionId, FIRST_ADMIN_USER_ID), stoppedAt: meta?.stoppedAt ?? '' },
        stoppedMs + 8 * DAY_MS,
      ),
    ).toBe('applied')
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.archived,
    ).toBe(true)
  })

  it('REFUSES an observation naming a different reader', async () => {
    // Under the old bare `readAt` this proposal was byte-indistinguishable from
    // the viewer's own, so a janitor sweeping someone else's read state would
    // have archived the session off everyone's board undetectably.
    const { reg, sessionId, stoppedMs } = await stoppedAndRead()
    const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(
      reg.modules.sessions.tryAutoArchiveStoppedObserved(
        {
          ...observation(sessionId, asUserId('user:other')),
          stoppedAt: meta?.stoppedAt ?? '',
        },
        stoppedMs + 8 * DAY_MS,
      ),
    ).toBe('precondition')
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.archived,
    ).toBe(false)
  })

  it('REFUSES an observation with no reader at all', async () => {
    // What an old v2 janitor's payload becomes once zod strips its unknown
    // `readAt`: a proposal naming nobody must fail CLOSED, never default to the
    // operator.
    const { reg, sessionId, stoppedMs } = await stoppedAndRead()
    const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    expect(
      reg.modules.sessions.tryAutoArchiveStoppedObserved(
        { ...observation(sessionId, ''), stoppedAt: meta?.stoppedAt ?? '' },
        stoppedMs + 8 * DAY_MS,
      ),
    ).toBe('precondition')
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.archived,
    ).toBe(false)
  })

  it('answers not-due while the read is still fresh — what the removed CAS used to catch', async () => {
    // POD-1229 dropped the compare-and-swap against `observed.readAt`. A re-read
    // moves the marker forward into the seven-day window, and the freshness
    // check below already refuses that — which is why the CAS was redundant.
    const { reg, sessionId, stoppedMs } = await stoppedAndRead()
    const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    reg.modules.sessions.markSessionRead(FIRST_ADMIN_USER_ID, sessionId) // re-read, "now"
    expect(
      reg.modules.sessions.tryAutoArchiveStoppedObserved(
        { ...observation(sessionId, FIRST_ADMIN_USER_ID), stoppedAt: meta?.stoppedAt ?? '' },
        stoppedMs + 1000,
      ),
    ).toBe('not-due')
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.archived,
    ).toBe(false)
  })

  it('REFUSES once the viewer marked it unread — the other half of the removed CAS', async () => {
    const { reg, sessionId, stoppedMs } = await stoppedAndRead()
    const meta = reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)
    reg.modules.sessions.markSessionUnread(FIRST_ADMIN_USER_ID, sessionId) // deletes the marker
    expect(
      reg.modules.sessions.tryAutoArchiveStoppedObserved(
        { ...observation(sessionId, FIRST_ADMIN_USER_ID), stoppedAt: meta?.stoppedAt ?? '' },
        stoppedMs + 8 * DAY_MS,
      ),
    ).toBe('precondition')
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.archived,
    ).toBe(false)
  })

  it('still refuses a stoppedAt that has moved since the observation', async () => {
    const { reg, sessionId, stoppedMs } = await stoppedAndRead()
    expect(
      reg.modules.sessions.tryAutoArchiveStoppedObserved(
        {
          ...observation(sessionId, FIRST_ADMIN_USER_ID),
          stoppedAt: '2020-01-01T00:00:00.000Z',
        },
        stoppedMs + 8 * DAY_MS,
      ),
    ).toBe('precondition')
    expect(
      reg.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.archived,
    ).toBe(false)
  })
})
