import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'

async function tmpDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'podium-store-'))
  return join(dir, 'podium.db')
}

describe('SessionStore repos', () => {
  it('starts empty, adds, dedupes, lists in insertion order, removes', () => {
    const store = new SessionStore(':memory:')
    expect(store.listRepos()).toEqual([])
    store.addRepo('/home/u/b')
    store.addRepo('/home/u/a')
    store.addRepo('/home/u/b') // dedupe
    expect(store.listRepos()).toEqual(['/home/u/b', '/home/u/a'])
    store.removeRepo('/home/u/b')
    expect(store.listRepos()).toEqual(['/home/u/a'])
    store.close()
  })

  it('persists repos across instances on the same file', async () => {
    const file = await tmpDbPath()
    const a = new SessionStore(file)
    a.addRepo('/abs/one')
    a.close()
    const b = new SessionStore(file)
    expect(b.listRepos()).toEqual(['/abs/one'])
    b.close()
  })

  it('exposes loadSessions() as [] on a fresh db (tables exist)', () => {
    const store = new SessionStore(':memory:')
    expect(store.loadSessions()).toEqual([])
    store.close()
  })
})
