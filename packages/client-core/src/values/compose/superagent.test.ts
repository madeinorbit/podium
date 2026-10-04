import { expect, it } from 'vitest'
import { threadById, type SuperThreadView } from './superagent'
it('resolves only a thread the principal received', () => {
  const mine: SuperThreadView[] = [{ id: 'global', kind: 'global' }, { id: 'btw_mine', kind: 'btw' }]
  expect(threadById(mine, 'btw_mine')?.id).toBe('btw_mine')
  expect(threadById(mine, 'btw_other')).toBeUndefined()
})
