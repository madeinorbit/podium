import { describe, expect, it } from 'vitest'
import { appRouter } from './router'
import { SessionRegistry } from './relay'

function caller() {
  const registry = new SessionRegistry() // in-memory store
  return appRouter.createCaller({ registry, repos: {} as never, superagent: {} as never })
}

describe('issues router', () => {
  it('creates and lists', async () => {
    const c = caller()
    const created = await c.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    expect(created.seq).toBe(1)
    const list = await c.issues.list({ repoPath: '/r' })
    expect(list.length).toBe(1)
  })

  it('updates stage', async () => {
    const c = caller()
    const created = await c.issues.create({ repoPath: '/r', title: 'X', startNow: false })
    const moved = await c.issues.update({ id: created.id, patch: { stage: 'in_progress' } })
    expect(moved.stage).toBe('in_progress')
  })
})
