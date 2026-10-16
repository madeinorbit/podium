/**
 * Durable session records cost a constant number of statements (POD-6160 D2b,
 * rule 8 of docs/agents/server-data.md).
 *
 * Each selection reads its candidate rows with one indexed query (two for a
 * Windows-style path), then the satellites of all of them with one query per
 * table. The fixture's sessions are not resident (an empty map), so every
 * answer comes from the database: the shape the map has once it holds running
 * sessions only.
 */
import { asIssueId, asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { RUNTIME_EVENT_LOG_KIND } from '../../store/events'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements, type StatementPin } from '../../test-support/statement-count'
import { SessionRecords, type SessionSubject } from './records'
import type { Session } from './session'

const WORKTREE = '/repo/.worktrees/issue-7'
const ISSUE = asIssueId('iss_records_7')
const PARENT = asSessionId('parent-0')

interface Fixture {
  store: SessionStore
  records: SessionRecords
  ids: SessionId[]
}

async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const owner = await firstAdminMemberId(store)
  const ids: SessionId[] = []
  await store.transact(async () => {
    for (let i = 0; i < size; i++) {
      const id = asSessionId(i === 0 ? PARENT : `rec-${String(i).padStart(4, '0')}`)
      ids.push(id)
      await store.sessions.upsertSession({
        id,
        ownerUserId: owner,
        agentKind: 'claude-code',
        cwd: i % 2 ? `${WORKTREE}/pkg-${i}` : `/elsewhere/${i}`,
        title: `Session ${i}`,
        name: null,
        originKind: i % 3 ? 'resume' : 'spawn',
        conversationId: i % 3 ? `conv-${i}` : null,
        resumeKind: i % 3 ? 'claude' : null,
        resumeValue: i % 3 ? `conv-${i}` : null,
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
        issueId: i % 5 === 0 ? ISSUE : null,
        stoppedAt: null,
        spawnedBy: i > 0 && i % 2 === 0 ? `session:${PARENT}` : null,
      } as never)
    }
  })
  for (const [index, id] of ids.entries()) {
    if (index % 3 === 0) {
      await store.sessions.setOffer(id, {
        message: 'next',
        actions: [{ label: 'Go', prompt: 'go' }],
        createdAt: '2026-10-01T00:00:00.000Z',
      })
    }
    if (index % 4 === 0) await store.sessions.setDraft(id, 'draft')
    if (index % 2 === 0) {
      await store.events.appendEvent({
        ts: '2026-09-01T00:00:00.000Z',
        kind: RUNTIME_EVENT_LOG_KIND,
        subject: id,
        payload: {
          t: 'item',
          item: { kind: 'complete', item: { id: `item-${index}`, role: 'assistant', text: 'hi', ts: '2026-09-01T00:00:00.000Z' } },
          at: '2026-09-01T00:00:00.000Z',
          provenance: 'live',
          observerGeneration: 1,
          turnEpoch: 1,
          cursor: { segmentId: 'segment', components: { seq: index } },
        },
      })
    }
  }
  const records = new SessionRecords({
    store,
    sessions: new Map<SessionId, Session>(),
    settled: () => true,
  })
  return { store, records, ids }
}

function pin(
  name: string,
  run: (f: Fixture) => Promise<SessionSubject[] | Map<SessionId, SessionSubject>>,
  minimum: (size: number) => number,
): StatementPin<Fixture> {
  return {
    name,
    setup: fixture,
    target: (f) => f.store,
    run,
    check: (result, _f, size) => {
      const count = result instanceof Map ? result.size : (result as SessionSubject[]).length
      expect(count).toBeGreaterThanOrEqual(minimum(size))
    },
    teardown: async (f) => await f.store.close(),
  }
}

describe('durable session records: constant statements', () => {
  it('reads every live session in a fixed number of statements', async () => {
    await expectConstantStatements(pin('records.all', (f) => f.records.all('pin'), (size) => size), 6)
  })

  it('reads a set of sessions by id in a fixed number of statements', async () => {
    await expectConstantStatements(
      pin('records.resolve', (f) => f.records.resolve(f.ids, 'pin'), (size) => size),
      6,
    )
  })

  it("reads one issue's member sessions in a fixed number of statements", async () => {
    await expectConstantStatements(
      pin('records.issueMembers', (f) => f.records.issueMembers(WORKTREE, ISSUE, 'pin'), () => 2),
      7,
    )
  })

  it('reads the sessions under a path in a fixed number of statements', async () => {
    await expectConstantStatements(
      pin('records.underPath', (f) => f.records.underPath(WORKTREE, 'pin'), () => 2),
      6,
    )
  })

  it("reads a machine's sessions in a fixed number of statements", async () => {
    await expectConstantStatements(
      pin('records.onMachine', (f) => f.records.onMachine(f.store.hostMachineId, 'pin'), (size) => size),
      6,
    )
  })

  it("reads a session's children in a fixed number of statements", async () => {
    await expectConstantStatements(
      pin('records.childrenOf', (f) => f.records.childrenOf([PARENT], 'pin'), () => 2),
      6,
    )
  })

  it("reads who a session acts for in one statement (D2c)", async () => {
    await expectConstantStatements(
      {
        name: 'records.ownershipOf',
        setup: fixture,
        target: (f) => f.store,
        run: async (f) => await f.records.ownershipOf(f.ids.at(-1)!, 'pin'),
        check: (result) => expect(result).toMatchObject({ cwd: expect.any(String) }),
        teardown: async (f) => await f.store.close(),
      },
      1,
    )
  })

  it('reads the sessions of an id prefix in a fixed number of statements', async () => {
    await expectConstantStatements(
      pin('records.withIdPrefix', (f) => f.records.withIdPrefix('rec-', 'pin'), (size) => size - 1),
      6,
    )
  })
})
