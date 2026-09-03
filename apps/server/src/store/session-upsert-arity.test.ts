/**
 * Rebase-seam regression: the runtime pilot added driver/login columns while
 * main added creator attribution columns. Keep one real migrated-schema write
 * carrying both families so INSERT column/value arity cannot drift silently.
 */

import { actorUser, asMachineId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'

describe('session upsert rebase seam', () => {
  it('persists driver, login, and creator columns in one current-schema row', () => {
    const db = openMigratedTestDatabase()
    const sessions = new SessionsRepository(createBunStoreExecutor({ database: db }))
    const row: SessionRow = {
      id: asSessionId('session-rebase-seam'),
      ownerUserId: FIRST_ADMIN_USER_ID,
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
      executionProfileId: null,
      deletedAt: null,
      deletionSource: null,
      deletedByIssueId: null,
      createdBy: {
        actor: actorUser(FIRST_ADMIN_USER_ID),
        onBehalfOf: FIRST_ADMIN_USER_ID,
      },
    }

    try {
      sessions.upsertSession(row)
      expect(sessions.getSession(row.id)).toMatchObject({
        loginHarness: 'codex',
        selectedDriverId: 'codex-app-server',
        createdBy: row.createdBy,
      })
    } finally {
      db.close()
    }
  })
})
