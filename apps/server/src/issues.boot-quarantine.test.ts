import { asSessionId, firstAdminMemberId } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { TEST_MACHINE_ID } from './test-support/machine-id'
/**
 * Boot crash-loop hardening (Phase 1, deliverable 3): a corrupt issue row must
 * never prevent IssueService construction/hydration — it is quarantined
 * (skipped + logged + counted) and every healthy row still loads.
 */

import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import { testStoreEngine } from './test-support/pg-test-database'
import { seedRaw } from './test-support/seed-rows'
import { sessionReadPorts } from './test-support/session-facts'
import { storeSql } from './test-support/store-sql'

/** Issues are placed on a machine that reported their repo (2b803efb5 refuses
 *  implicit placement), so the host machine reports the fixture repo. */
async function reportingStore(): Promise<SessionStore> {
  const store = await openTestStore(':memory:', TEST_MACHINE_ID)
  await store.repos.addRepo('/r', store.hostMachineId)
  return store
}

function deps(store: SessionStore): IssueDeps {
  return {
    resolveMachine: async () => TEST_MACHINE_ID,
    store,
    ...sessionReadPorts(() => []),
    getSettings: async () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(async () => ({
      sessionId: asSessionId('s1'),
      machine: 'machine-under-test',
    })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(undefined, { store }),
  }
}

/** White-box seam: the store's own SQLite connection, for the corrupt value only SQLite can hold. */
type RawDb = {
  prepare(q: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown }
  exec(q: string): void
}
function rawDb(s: SessionStore): RawDb {
  return (s as unknown as { db: RawDb }).db
}

/** Every message down `error`'s cause chain, joined: a driver's refusal sits at the bottom. */
async function failureOf(write: Promise<unknown>): Promise<string> {
  try {
    await write
  } catch (error) {
    const messages: string[] = []
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      messages.push(cause.message)
    }
    return messages.join('\n')
  }
  throw new Error('the write was not refused')
}

const AT = '2026-07-01T00:00:00.000Z'

describe('IssueService boot quarantine', () => {
  it('loads no issue rows into memory to construct (POD-6158)', async () => {
    const store = await openTestStore(':memory:', TEST_MACHINE_ID)
    const listSpy = vi.spyOn(store.issues, 'listIssueRows')
    await IssueService.create(deps(store))
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('a NULL id cannot be stored: the key refuses it (POD-7024)', async () => {
    // SQLite once permitted NULL in a TEXT primary key, and the boot load skipped such a row.
    // Since the keys migration the key is (workspace_id, id) with both NOT NULL.
    const store = await reportingStore()
    const admin = firstAdminMemberId()
    expect(
      await failureOf(
        storeSql(store).run(
          sql`INSERT INTO issues (workspace_id, id, owner_user_id, created_by_actor, created_by_on_behalf_of,
                repo_path, seq, title, stage, default_agent, created_at, updated_at)
              VALUES (${SELF_HOSTED_WORKSPACE_ID}, NULL, ${admin}, ${admin},
                      ${admin}, '/r', 99, 'poisoned', 'backlog', 'claude-code', ${AT}, ${AT})`,
        ),
      ),
    ).toMatch(
      /NOT NULL constraint failed: issues\.id|null value in column "id" of relation "issues" violates not-null constraint/,
    )
  })

  // A json column on Postgres refuses non-JSON text, so this corruption exists only on SQLite.
  it.skipIf(testStoreEngine() === 'pg')(
    'bad JSON in a column quarantines the VALUE but keeps the row',
    async () => {
      const store = await reportingStore()
      const svc = await IssueService.create(deps(store))
      const w = await svc.crud.create(svc.reports.store.serverWriter, {
        repoPath: '/r',
        title: 'keep me',
        startNow: false,
      })
      seedRaw(rawDb(store), () =>
        rawDb(store)
          .prepare('UPDATE issues SET blocked_by = ? WHERE id = ?')
          .run('{not json', w.id),
      )

      const rebooted = await IssueService.create(deps(store))
      const row = await rebooted.reports.get(w.id)
      expect(row?.id).toBe(w.id)
      expect((await store.issues.getIssue(w.id))?.blockedBy).toEqual([])
    },
  )
})
