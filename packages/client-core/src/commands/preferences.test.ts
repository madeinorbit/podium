import { pinRowId, tabOrderRowId, userPreferencesRowId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { harness, sessionId, ME } from './commands.test.fixture'
describe('engine action ownership boundary', () => {
  it('queues pins, tab orders and personal settings as generic edits of my records (POD-6673)', async () => {
    const h = harness()

    await h.actions.setPinned('panel', sessionId, true)
    await h.actions.setPinned('repo', '/repo', false)
    await h.actions.setTabOrder('/w', [sessionId])
    await h.actions.setTabOrder('/x', [])
    await h.actions.setPreferences({
      'sidebar.repoSort': 'custom',
      'roles.coding.harness': undefined,
    })

    expect(h.queued).toEqual([
      {
        kind: 'recordCreate',
        input: {
          kind: 'pin',
          id: pinRowId(ME, 'panel', sessionId),
          fields: { userId: ME, kind: 'panel', entityId: sessionId },
        },
      },
      { kind: 'recordRemove', input: { kind: 'pin', id: pinRowId(ME, 'repo', '/repo') } },
      {
        kind: 'recordEdit',
        input: {
          kind: 'tabOrder',
          id: tabOrderRowId(ME, '/w'),
          patch: { sessionIds: [sessionId] },
        },
      },
      { kind: 'recordRemove', input: { kind: 'tabOrder', id: tabOrderRowId(ME, '/x') } },
      {
        kind: 'recordEdit',
        input: {
          kind: 'userPreferences',
          id: userPreferencesRowId(ME),
          patch: { 'sidebar.repoSort': 'custom' },
          unset: ['roles.coding.harness'],
        },
      },
    ])
  })
})
