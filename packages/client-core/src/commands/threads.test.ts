import { superagentThreadRowId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { harness, ME } from './test-support'
describe('engine action ownership boundary', () => {
  it('queues the prompt box’s model and effort as an edit of my thread record (POD-6675)', async () => {
    const h = harness()
    await h.actions.setSuperagentBackend('global', { model: 'opus', effort: 'auto' })
    await h.actions.setSuperagentBackend('global', { effort: 'high' })
    await h.actions.setSuperagentBackend('global', {})
    const thread = superagentThreadRowId(ME, 'global')
    expect(h.queued).toEqual([
      {
        kind: 'recordEdit',
        // `auto` clears the field: the thread follows the settings role again.
        input: {
          kind: 'superagentThread',
          id: thread,
          patch: { model: 'opus' },
          unset: ['effort'],
        },
      },
      {
        kind: 'recordEdit',
        input: { kind: 'superagentThread', id: thread, patch: { effort: 'high' } },
      },
    ])
  })
})
