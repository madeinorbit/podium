import { describe, expect, it } from 'vitest'
import { fixtureUi } from '../test-support/ui'
import { createNotices } from './notices'

describe('the device notice queue', () => {
  it('queues errors and info with their description and clears them at disposal', () => {
    const ui = fixtureUi()
    const notices = createNotices(() => ui)
    notices.error('Could not save')
    notices.info('Session moved', '/repo/worktree')
    expect(
      ui.notices.map(({ kind, message, description }) => ({ kind, message, description })),
    ).toEqual([
      { kind: 'error', message: 'Could not save', description: undefined },
      { kind: 'info', message: 'Session moved', description: '/repo/worktree' },
    ])
    ui.dismissNotice(ui.notices[0]!.id)
    expect(ui.notices).toHaveLength(1)
    ui.dispose()
    expect(ui.notices).toHaveLength(0)
  })

  it('keeps direct runtime delivery synchronous and consumes only the delivered toast', () => {
    const ui = fixtureUi()
    const delivered: unknown[] = []
    const notices = createNotices(() => ui, {
      error: (message) => delivered.push({ kind: 'error', message, pending: ui.notices.length }),
      info: (message, description) =>
        delivered.push({ kind: 'info', message, description, pending: ui.notices.length }),
    })
    ui.addNotice({ id: 'existing', kind: 'info', message: 'Waiting for another consumer' })

    notices.error('Could not save')
    notices.info('Session moved', '/repo/worktree')

    expect(delivered).toEqual([
      { kind: 'error', message: 'Could not save', pending: 2 },
      { kind: 'info', message: 'Session moved', description: '/repo/worktree', pending: 2 },
    ])
    expect(ui.notices.map((notice) => notice.id)).toEqual(['existing'])
    ui.dispose()
  })
})
