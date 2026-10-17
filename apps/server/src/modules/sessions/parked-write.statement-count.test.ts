/**
 * A WRITE TO A PARKED SESSION RUNS A FIXED NUMBER OF STATEMENTS (POD-6210).
 *
 * Since the session map holds running sessions only (POD-6160 D2g), a rename of
 * a stopped session finds it out of memory, and its lease restores it from its
 * row (`residency.ts`). The server-data bench renames sessions across the whole
 * table (1,860/min), so this is the operation that carried D2's extra reads, not
 * the daemon frames (they go to running sessions, which are resident). Pinned
 * through the real tRPC procedure, one operation (`trpc.ts` `oneOperation`), at
 * 5 and 200 parked sessions.
 *
 * 19 statements, by what they are for:
 * - access: the machines and their grants for the caller's machine-use
 *   snapshot (2), the session's row (1) through the operation's session
 *   loader, its grants (1) through the operation's grant loader;
 * - the restore for the lease: the row again from the same loader (0), then its
 *   satellites, one read per table (6: offers, draft times, observation
 *   checkpoint, runtime turn state, runtime transcript presence, conversation
 *   id). The published meta carries every one of them;
 * - the write: the row upsert, the change and its latest copy (3), the
 *   projection pass's queued-input count and pending-mail count (2), the folder
 *   owner (1), the stored latest change it is compared with (1), the change
 *   log's lowest sequence (1);
 * - the publication's visibility pass reads the written row again (1).
 * Before POD-6210 the access check read the row with its own statement and the
 * lease read it a second time: 20.
 */
import { asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import type { SessionStore } from '../../store'
import { RUNTIME_EVENT_LOG_KIND } from '../../store/events'
import { OPERATOR } from '../../test-support/capabilities'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements, quietShipping } from '../../test-support/statement-count'
import { SuperagentService } from '../superagent'

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  ids: SessionId[]
  call: ReturnType<typeof appRouter.createCaller>
}

const at = '2026-10-16T12:00:00.000Z'

async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const owner = firstAdminMemberId()
  const ids: SessionId[] = []
  await store.transact(async () => {
    for (let i = 0; i < size; i++) {
      const id = asSessionId(`parked-${String(i).padStart(4, '0')}`)
      ids.push(id)
      await store.sessions.upsertSession({
        id,
        ownerUserId: owner,
        agentKind: 'claude-code',
        cwd: `/w/${i}`,
        title: `Session ${i}`,
        name: null,
        originKind: 'resume',
        conversationId: `conv-${i}`,
        resumeKind: 'claude',
        resumeValue: `conv-${i}`,
        status: i % 4 === 0 ? 'hibernated' : 'exited',
        exitCode: 0,
        durableLabel: `podium-${id}`,
        createdAt: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        lastActiveAt: '2026-09-02T00:00:00.000Z',
        lastOutputAt: null,
        lastInputAt: null,
        lastResumedAt: null,
        archived: false,
        workState: null,
        machineId: store.hostMachineId,
        headless: false,
        issueId: null,
        stoppedAt: '2026-09-02T00:00:00.000Z',
        spawnedBy: null,
      } as never)
    }
  })
  for (const [index, id] of ids.entries()) {
    await store.sessions.setOffer(id, { message: 'next', actions: [{ label: 'Go', prompt: 'go' }], createdAt: at })
    await store.sessions.setDraft(id, 'draft')
    await store.events.appendEvent({
      ts: at,
      kind: RUNTIME_EVENT_LOG_KIND,
      subject: id,
      payload: {
        t: 'item',
        item: { kind: 'complete', item: { id: `item-${index}`, role: 'assistant', text: 'hi', ts: at } },
        at,
        provenance: 'live',
        observerGeneration: 1,
        turnEpoch: 1,
        cursor: { segmentId: 'segment', components: { seq: index } },
      },
    })
  }
  const reg = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    sessionResidency: { evictParked: true, sweepIntervalMs: 0 },
  })
  await attachHostDaemon(reg, () => {})
  await quietShipping(reg)
  const repos = new RepoRegistry(reg, reg.sessionStore)
  const superagent = await SuperagentService.create(reg.modules, repos, reg.sessionStore)
  const call = appRouter.createCaller({
    registry: reg,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(owner, 'admin'),
  })
  await settle(reg)
  return { store, reg, ids, call }
}

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('a write to a parked session: constant statements', () => {
  it('renames a parked session over tRPC', async () => {
    await expectConstantStatements<Fixture>(
      {
        name: 'sessions.rename (parked)',
        setup: fixture,
        target: (f) => f.store,
        run: async (f) => {
          const id = f.ids.at(-1)!
          expect(f.reg.modules.sessions.sessions.has(id)).toBe(false)
          await f.call.sessions.rename({ sessionId: id, name: 'Renamed' })
          await settle(f.reg)
          return id
        },
        check: async (id, f) => {
          expect((await f.store.sessions.loadSession(id as SessionId))?.name).toBe('Renamed')
        },
        teardown: async (f) => await f.reg.dispose(),
      },
      19,
    )
  })
})
