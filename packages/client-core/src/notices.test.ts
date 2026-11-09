import { describe, expect, it } from 'vitest'
import { fixtureUi } from '../test-support/ui'
import { createNotices } from './notices'

describe('the device notice queue', () => {
  it('queues errors and info with their description and clears them at disposal', () => {
    const ui = fixtureUi()
    const notices = createNotices(() => ui)
    notices.error('Could not save')
    notices.info('Session moved', '/repo/worktree')
    expect(ui.notices.map(({ kind, message, description }) => ({ kind, message, description }))).toEqual([
      { kind: 'error', message: 'Could not save', description: undefined },
      { kind: 'info', message: 'Session moved', description: '/repo/worktree' },
    ])
    ui.dismissNotice(ui.notices[0]!.id)
    expect(ui.notices).toHaveLength(1)
    ui.dispose()
    expect(ui.notices).toHaveLength(0)
  })
})
