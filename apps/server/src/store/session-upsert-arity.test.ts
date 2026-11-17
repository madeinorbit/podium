/**
 * Rebase-seam regression: the runtime pilot added driver/login columns while
 * main added creator attribution columns. Keep one real migrated-schema write
 * carrying both families so INSERT column/value arity cannot drift silently.
 */

import { actorUser, asMachineId, asSessionId, asUserId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'
import { drainedRepository } from '../test-support/drained-repository'
import { openSliceStore, type SliceStore } from '../test-support/pg-slice-tables'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'

// A member's id; `sessions` names no member row, and a Postgres clone seeds none.
const OWNER = asUserId('user:alice')

describe('session upsert rebase seam', () => {
  it('persists driver, login, and creator columns in one current-schema row', async () => {
    // On the run's engine: SQLite on the store shard, Postgres on `server-store-pg` (POD-6983).
    const slice = await openSliceStore()
    const sessions = drainedRepository(slice, new SessionsRepository(slice.queries))
    const row: SessionRow = {
      id: asSessionId('session-rebase-seam'),
      ownerUserId: OWNER,
      agentKind: 'codex',
      loginHarness: 'codex',
      selectedDriverId: 'codex-app-server',
      cwd: '/workspace',
      title: 'Rebase seam',
      name: null,
      nameSource: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'live',
      exitCode: null,
      spawnFailure: null,
      durableLabel: 'podium-session-rebase-seam',
      createdAt: '2026-08-20T00:00:00.000Z',
      lastActiveAt: '2026-08-20T00:00:00.000Z',
      geometry: { cols: 120, rows: 40 },
      archived: false,
      workState: null,
      machineId: asMachineId('machine-rebase-seam'),
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      spawnedBy: 'user',
      headless: true,
      issueId: null,
      refIssueId: null,
      refLetter: null,
      refDraft: null,
      stoppedAt: null,
      stopReason: null,
      workflowRunId: null,
      workflowStepId: null,
      agentProfileId: null,
      deletedAt: null,
      deletionSource: null,
      deletedByIssueId: null,
      createdBy: {
        actor: actorUser(OWNER),
        onBehalfOf: OWNER,
      },
    }

    try {
      await sessions.upsertSession(fixtureWriteScope(), row)
      expect(await sessions.getSession(row.id)).toMatchObject({
        loginHarness: 'codex',
        selectedDriverId: 'codex-app-server',
        createdBy: row.createdBy,
      })
    } finally {
      await slice.close()
    }
  })
})
