/**
 * WHOSE SESSION OVERLAY THE BROADCAST CARRIES — the reproduce witness for
 * PDM-424, against the real `SessionView` rather than a re-implementation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PINS, AND WHY IT IS NOT `broadcastViewer()`
 * ---------------------------------------------------------------------------
 *
 * This issue's brief named `SessionView.broadcastViewer()` as the site. It is
 * not the one a member sees. That method's only two consumers are
 * `session-meta-ops.ts`'s `prepareIssueSessionDelete` — which builds metas ONLY
 * to run `sessionsForIssue()` for membership and DISCARDS the overlay — and
 * `session-teardown.ts`, a janitor decision. Both are the class PDM-408
 * deliberately kept on a named viewer.
 *
 * The leak a member actually sees is a PRINCIPAL-LESS projection pass:
 *
 *   repository.ts:382  const pass = await this.view.buildProjectionPass(candidates)
 *   repository.ts:391  value: await this.view.wire(session, pass)      <- into the ledger
 *   view.ts:238        const overlayUser = forPrincipal ? forPrincipal.userId
 *                                                       : await this.internalOverlayUser()
 *   view.ts:268        overlaySnapshot(overlayUser, ids)
 *   view.ts:368        session.toMeta(pass.overlays.get(...) ?? NO_SESSION_USER_STATE, d)
 *   session.ts:1145/1148/1175   readAt / unread / snoozedUntil
 *
 * So every `entity: 'session'` upsert, and the boot baseline at
 * `repository.ts:980`, carries the EARLIEST ADMIN's read and snooze state to
 * every client.
 *
 * ---------------------------------------------------------------------------
 * THE SINGLE-ADMIN TRAP, WHICH IS WHY EVERY CASE SETS A NON-DEFAULT FIRST
 * ---------------------------------------------------------------------------
 *
 * On an instance whose only member is the admin, "the admin's overlay" and "the
 * neutral overlay" are THE SAME BYTES — `readAt: null`, `unread: true`, no
 * `snoozedUntil`. An assertion over an untouched session therefore passes
 * whether the wire is neutral or is still reading her overlay, and proves
 * nothing either way. PDM-408 rebuilt its tests for exactly this. So each case
 * below asserts, as a PRECONDITION, that the admin's stored overlay holds
 * non-default values before it asserts anything about the wire.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POSITIVE MATTERS AS MUCH AS THE REFUSAL
 * ---------------------------------------------------------------------------
 *
 * A producer that neutralised EVERY overlay would pass every refusal here. The
 * principal-ful case is the pairing: a pass built FOR a member must still carry
 * that member's own values. Without it "carries nobody's marks" is satisfied by
 * a projection that carries nobody's anything.
 *
 * `internalOverlayUser()` is NOT stubbed. `view.projection-pass.test.ts` spies
 * on it deliberately, for a budget comparison — here that spy would switch off
 * the mechanism under test.
 */

import { asMachineId, asSessionId, asUserId, type SessionMeta, type UserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { Session } from './session'
import { SessionAuthz } from './session-authz'
import { type SessionStatePrincipal, SessionStateService } from './session-state/service'
import { SessionView } from './view'

const machineId = asMachineId('overlay-machine')
const SESSION = asSessionId('overlay-session')

/** Non-default on BOTH overlay members, so neither can coincide with neutral. */
const ADMIN_READ_AT = '2026-09-11T00:00:00.000Z'
const MEMBER_READ_AT = '2026-09-11T06:00:00.000Z'
/**
 * DERIVED FROM THE CLOCK, DELIBERATELY, where every other date here is fixed.
 * `SessionsRepository.listSnoozes` LAZILY DELETES a row whose deadline has
 * passed (store/sessions.ts:707-719), so a hardcoded deadline stops being a
 * snooze the day it goes by — and the admin's overlay then reads
 * `snoozedUntil: undefined`, which is the same bytes as neutral. The first draft
 * of this file used a fixed date and its PRECONDITIONS failed for exactly that
 * reason, which is the failure the preconditions exist to catch. The snooze must
 * be LIVE for this fixture to discriminate at all; nothing here asserts the
 * particular instant.
 */
const ADMIN_SNOOZE_UNTIL = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

function principalFor(userId: UserId): SessionStatePrincipal {
  return {
    userId,
    humanDirect: true,
    onBehalfOf: userId,
    capability: { role: 'worker', scope: { kind: 'none' } },
  }
}

async function fixture() {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/overlay', machineId, undefined, 'OVL')

  // The earliest admin is whoever the store minted at open; resolve rather than
  // assume a spelling, and assert the two identities differ so the whole file
  // is not silently comparing one person with themselves.
  const adminRow = await store.users.earliestAdmin()
  if (!adminRow) throw new Error('fixture: the test store minted no administrator')
  const admin = asUserId(adminRow.id)
  const member = asUserId('overlay-member')
  await store.users.create(
    {
      id: member,
      displayName: 'Member',
      role: 'member',
      createdAt: '2026-09-10T00:00:00.000Z',
      disabledAt: null,
    },
    'test-only',
  )

  // OWNED BY THE MEMBER, so the member's own principal can read it. The admin
  // still holds per-user rows against it: a read mark and a snooze are personal
  // state, and nothing stops a person marking a session they can see.
  const session = new Session({
    sessionId: SESSION,
    durableLabel: 'overlay-session',
    agentKind: 'claude-code',
    cwd: '/overlay/work',
    title: 'Overlay session',
    origin: { kind: 'spawn' },
    createdAt: '2026-09-10T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId,
    toDaemon: () => {},
    ownerUserId: member,
  })
  // lastActiveAt BEFORE both read marks, so `unread` is decided by WHOSE readAt
  // the wire carries rather than by activity — otherwise every reader is unread
  // and the flag cannot discriminate.
  session.lastActiveAt = '2026-09-10T12:00:00.000Z'

  const sessions = new Map([[session.sessionId, session]])
  const authz = new SessionAuthz({ sessions, store } as never)
  const state = new SessionStateService({
    store,
    getSession: (id: string) => sessions.get(asSessionId(id)),
    sessionOwner: (args: { sessionId: string; memo: unknown }) =>
      authz.sessionOwner(args.sessionId as never, args.memo as never),
    primeOwnerMemo: (memo: never, ids: never) => authz.primeOwnerMemo(memo, ids),
  } as never)
  const machines = {
    factsSnapshot: vi.fn(async () => ({
      name: () => 'Build box',
      loginCondition: () => 'logged-out' as const,
    })),
    machineName: async () => 'Build box',
    agentLoginCondition: async () => 'logged-out' as const,
  }
  const view = new SessionView({
    sessions,
    store,
    state,
    machines: machines as never,
    sessionOccupancyCount: () => 1,
  })

  // THE ADMIN'S NON-DEFAULT STATE. Written through the store directly: the
  // question here is what the PROJECTION does with an existing row, not how the
  // row got there, and the command path is already per-principal (see
  // session-state/registry.ts's `ownPerUserSessionRow` handlers).
  await store.sessions.markSessionRead(admin, SESSION, ADMIN_READ_AT)
  await store.sessions.setSnooze(admin, SESSION, ADMIN_SNOOZE_UNTIL)

  return { store, session, sessions, state, view, admin, member }
}

/** The wire a principal-less pass produces — repository.ts:382/391's shape. */
async function broadcastWire(f: Awaited<ReturnType<typeof fixture>>): Promise<SessionMeta> {
  const pass = await f.view.buildProjectionPass([f.session])
  return await f.view.wire(f.session, pass)
}

describe('the session broadcast overlay', () => {
  it('does not carry the earliest admin read mark to everybody', async () => {
    const f = await fixture()
    expect(f.admin).not.toBe(f.member)
    // PRECONDITION — without this the assertion below is satisfied by neutral
    // and by the admin's overlay alike, because they would be the same bytes.
    expect(await f.state.overlay(f.admin, SESSION)).toEqual({
      readAt: ADMIN_READ_AT,
      snoozedUntil: ADMIN_SNOOZE_UNTIL,
    })

    const wire = await broadcastWire(f)

    expect.soft(wire.readAt).toBeNull()
    expect.soft(wire.unread).toBe(true)
    expect.soft(wire.snoozedUntil).toBeUndefined()
  })

  it('still carries a member their OWN marks when the pass names them', async () => {
    const f = await fixture()
    await f.store.sessions.markSessionRead(f.member, SESSION, MEMBER_READ_AT)
    // Both halves non-default and DIFFERENT from each other, so a wire that
    // served the admin's row would fail this rather than coincide with it.
    expect(await f.state.overlay(f.member, SESSION)).toEqual({
      readAt: MEMBER_READ_AT,
      snoozedUntil: undefined,
    })

    const pass = await f.view.buildProjectionPass([f.session], principalFor(f.member))
    const wire = await f.view.wire(f.session, pass)

    expect.soft(wire.readAt).toBe(MEMBER_READ_AT)
    expect.soft(wire.unread).toBe(false)
    expect.soft(wire.snoozedUntil).toBeUndefined()
  })

  it('does not carry the earliest admin snooze to a member who never snoozed', async () => {
    const f = await fixture()
    expect((await f.state.overlay(f.admin, SESSION)).snoozedUntil).toBe(ADMIN_SNOOZE_UNTIL)
    expect((await f.state.overlay(f.member, SESSION)).snoozedUntil).toBeUndefined()

    const wire = await broadcastWire(f)

    expect(wire.snoozedUntil).toBeUndefined()
  })
})
