import { DEFAULT_SETTINGS } from '@podium/runtime'
import { expect, it } from 'vitest'
import { MobxPool } from './pool'
import { ingestSettings } from './requested-record-source'
import { SettingsRecordRequest } from './requested-records'

it('shares header-ingested settings with view requests through feed replacement and view closure', async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  const request = new SettingsRecordRequest(pool)
  const before = {
    ...DEFAULT_SETTINGS,
    gitWorkflow: { ...DEFAULT_SETTINGS.gitWorkflow, defaultParentBranch: 'header' },
  }
  const after = {
    ...DEFAULT_SETTINGS,
    gitWorkflow: { ...DEFAULT_SETTINGS.gitWorkflow, defaultParentBranch: 'requested' },
  }
  try {
    ingestSettings(pool, before)
    const retained = request.model
    expect(retained?.gitWorkflow).toEqual(before.gitWorkflow)
    expect(request.loading).toBe(false)

    await request.read(async () => after)
    expect(request.model).toBe(retained)
    expect(retained?.gitWorkflow).toEqual(after.gitWorkflow)

    pool.apply({ type: 'replace', rows: [] })
    expect(request.model).toBe(retained)
    expect(retained?.gitWorkflow).toEqual(after.gitWorkflow)

    request.dispose()
    ingestSettings(pool, before)
    expect(request.model).toBe(retained)
    expect(retained?.gitWorkflow).toEqual(before.gitWorkflow)
  } finally {
    request.dispose()
    pool.dispose()
  }
})
