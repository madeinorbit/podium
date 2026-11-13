/**
 * The credential record in the pool (credential management Task 4): rows that
 * `credentials.list` returns become one shared model per credential.
 */

import type { CredentialView } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { here } from './lookup'
import { MobxPool } from './pool'
import { ingestRequested } from './requested-record-source'

const view = (over: Partial<CredentialView> = {}): CredentialView =>
  ({
    id: 'cred_00000000-0000-4000-8000-000000000001',
    ownerUserId: 'user:owner',
    label: 'Work key',
    type: 'anthropic.api-key',
    identity: { fingerprint: '0123456789abcdef', masked: 'sk-a…1234' },
    status: 'ok',
    homes: [],
    allowedMachines: [],
    sessionCount: 0,
    access: 'owner',
    ...over,
  }) as CredentialView

describe('CredentialModel', () => {
  it('holds what credentials.list returned, one model per id', () => {
    const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
    const [id] = ingestRequested(pool, 'credential', [view()], (row) => row.id)
    const model = here(pool.model('credential', id as string))
    expect(model?.label).toBe('Work key')
    expect(model?.identity.masked).toBe('sk-a…1234')
    expect(model?.canManage).toBe(true)

    ingestRequested(pool, 'credential', [view({ label: 'Renamed', access: 'use' })], (r) => r.id)
    expect(here(pool.model('credential', id as string))).toBe(model)
    expect(model?.label).toBe('Renamed')
    expect(model?.canManage).toBe(false)
  })
})
