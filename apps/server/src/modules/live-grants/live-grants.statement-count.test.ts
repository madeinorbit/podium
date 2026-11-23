/**
 * A CLIENT GRANT READS THE SAME STATEMENTS FOR 1 AND FOR 1,000 IDS
 * (POD-7311 acceptance 2, second half; server-data rule 8).
 *
 * The screen names `size` sessions and `size` machines. A third of the
 * sessions are Alice's on her machine, a third Bob's on the machine he shares
 * with her, the rest unknown; the machines are the three real ones and
 * `size - 3` unknown ids. Five reads: the sessions' owners and hosts, the
 * machine rows, their grant edges, and the registered roots with their prefixes
 * (`listRepos` reads both). The operation runs as
 * the route runs it, inside one operation scope, signature included.
 */

import { LiveGrantKeyRing, mintLiveGrantKey, verifyLiveGrant } from '@podium/live-grants'
import { asMachineId, asSessionId, type SessionId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import type { SessionStore } from '../../store'
import { withOperation } from '../../store/executor/operation-scope'
import {
  ALICE,
  BOB,
  grantSources,
  M_ALICE,
  M_PRIVATE,
  M_SHARED,
  principalOf,
  ROLE,
  seedGrantWorld,
} from '../../test-support/live-grant-fixture'
import { openTestStore } from '../../test-support/open-test-store'
import {
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { session } from '../../test-support/workspace-seeds/sessions'
import { issueClientGrant } from './route'

interface Fixture {
  store: SessionStore
  sessions: SessionId[]
  machines: string[]
}

const ring = new LiveGrantKeyRing([mintLiveGrantKey('pin')])
const at = (i: number) => new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString()

async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  await seedGrantWorld(store)
  const sessions = Array.from({ length: size }, (_, i) => asSessionId(`pin-${i}`))
  const rows = sessions
    .map((id, i) => ({ id, i }))
    .filter(({ i }) => i % 3 !== 2)
    .map(({ id, i }) =>
      session('a', 1, {
        id,
        ownerUserId: i % 3 === 0 ? ALICE : BOB,
        machineId: i % 3 === 0 ? M_ALICE : M_SHARED,
        resumeValue: `pin-resume-${i}`,
        durableLabel: `pin-${i}`,
        createdAt: at(i),
        lastActiveAt: at(i),
      }),
    )
  if (rows.length > 0) await store.sessions.upsertSessions(fixtureWriteScope(), rows)
  const machines = [
    ...[M_ALICE, M_SHARED, M_PRIVATE].slice(0, size),
    ...Array.from({ length: Math.max(0, size - 3) }, (_, i) => asMachineId(`unknown-${i}`)),
  ]
  return { store, sessions, machines }
}

const pin: StatementPin<Fixture> = {
  name: 'live client grant',
  sizes: [1, 1000],
  setup: fixture,
  target: (f) => f.store,
  run: async (f) =>
    await withOperation(
      async () =>
        await issueClientGrant(
          { sources: grantSources(f.store), keys: { ring: async () => ring } },
          SELF_HOSTED_WORKSPACE_ID,
          { principal: principalOf(ALICE), role: ROLE[ALICE]! },
          { sessions: f.sessions, machines: f.machines },
        ),
    ),
  check: (result, f, size) => {
    const token = (result as { token: string }).token
    const verified = verifyLiveGrant(token, {
      keys: ring.publicOnly(),
      workspace: SELF_HOSTED_WORKSPACE_ID,
      kind: 'client',
    })
    if (!verified.ok) throw new Error(verified.refusal)
    const named = [...verified.grant.sessionIds()]
    // Exactly Alice's own: every third id.
    expect(named.length).toBe(Math.ceil(size / 3))
    expect(named.every((id) => Number(id.slice('pin-'.length)) % 3 === 0)).toBe(true)
    expect(verified.grant.allowsSession(f.sessions[0]!, 'use')).toBe(true)
    expect(verified.grant.allowsMachine(M_ALICE, 'use')).toBe(true)
    expect(verified.grant.allowsMachine(M_PRIVATE, 'view')).toBe(false)
  },
  teardown: async (f) => await f.store.close(),
}

describe('live client grant statement count', () => {
  it('is five statements for 1 and for 1,000 ids', async () => {
    await expectConstantStatements(pin, 5)
  })

  it('is armed: a read per session on its path fails the pin', async () => {
    await expectArmed(pin, 5, (f) => {
      const sessions = f.store.sessions
      const original = sessions.bindingConfirmations.bind(sessions)
      sessions.bindingConfirmations = async (ids) => {
        for (const id of ids) await sessions.getSession(id)
        return await original(ids)
      }
      return () => {
        sessions.bindingConfirmations = original
      }
    })
  })
})
