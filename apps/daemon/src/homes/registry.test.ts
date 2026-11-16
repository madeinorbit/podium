import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type HarnessHome, HomeRegistry } from './registry'

const CRED_A = 'cred_0b6f6f5e-2d43-4f7a-9d55-6a1f7c3e0e11'
const CRED_B = 'cred_7d1c2b0a-9e8f-4a6b-8c5d-1e2f3a4b5c6d'

let state: string
let root: string

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'podium-homes-'))
  root = join(state, 'homes')
})

afterEach(() => {
  rmSync(state, { recursive: true, force: true })
})

describe('HomeRegistry', () => {
  it('ensure twice returns the same owner-only home at <root>/<credential>/<harness>', async () => {
    const homes = new HomeRegistry({ root })
    const first = await homes.ensure(CRED_A, 'codex')
    const second = await homes.ensure(CRED_A, 'codex')
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.home).toEqual(first.home)
    expect(first.home).toEqual({
      homeId: `${CRED_A}:codex`,
      credentialId: CRED_A,
      harness: 'codex',
      dir: join(root, CRED_A, 'codex'),
    })
    expect(statSync(first.home.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, CRED_A)).mode & 0o777).toBe(0o700)
    expect(statSync(root).mode & 0o777).toBe(0o700)
  })

  it('lists and gets every home it holds, from the directory alone', async () => {
    await new HomeRegistry({ root }).ensure(CRED_A, 'codex')
    await new HomeRegistry({ root }).ensure(CRED_B, 'claude-code')
    // A fresh registry over the same directory: the filesystem is the record.
    const homes = new HomeRegistry({ root })
    expect(
      homes
        .list()
        .map((home) => home.homeId)
        .sort(),
    ).toEqual([`${CRED_A}:codex`, `${CRED_B}:claude-code`].sort())
    expect(homes.get(`${CRED_B}:claude-code`)?.dir).toBe(join(root, CRED_B, 'claude-code'))
    expect(homes.get(`${CRED_B}:codex`)).toBeUndefined()
    expect(homes.get('default')).toBeUndefined()
  })

  it('lists nothing before the first home and ignores entries that are not homes', async () => {
    const homes = new HomeRegistry({ root })
    expect(homes.list()).toEqual([])
    await homes.ensure(CRED_A, 'codex')
    writeFileSync(join(root, 'stray.txt'), 'x')
    writeFileSync(join(root, CRED_A, 'grok'), 'x')
    expect(homes.list().map((home) => home.homeId)).toEqual([`${CRED_A}:codex`])
  })

  it('refuses a credential id that could leave the homes directory, and a harness without homes', async () => {
    const homes = new HomeRegistry({ root })
    await expect(homes.ensure('../escape', 'codex')).rejects.toThrow()
    await expect(homes.ensure('cred_..', 'codex')).rejects.toThrow()
    await expect(homes.ensure(CRED_A, 'grok' as never)).rejects.toThrow()
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
    expect(existsSync(join(state, 'escape'))).toBe(false)
  })

  it('remove stops what runs in the home first, then deletes it and counts what it held', async () => {
    const order: string[] = []
    const homes = new HomeRegistry({
      root,
      beforeRemove: async (home: HarnessHome) => {
        order.push(`stop:${home.homeId}`)
        expect(existsSync(home.dir)).toBe(true)
      },
    })
    const { home } = await homes.ensure(CRED_A, 'codex')
    writeFileSync(join(home.dir, 'blob'), Buffer.alloc(1024))
    const result = await homes.remove(home.homeId)
    order.push('removed')
    expect(result.removed).toBe(true)
    expect(result.freedBytes).toBeGreaterThanOrEqual(1024)
    expect(existsSync(home.dir)).toBe(false)
    expect(existsSync(join(root, CRED_A))).toBe(false)
    expect(order).toEqual([`stop:${home.homeId}`, 'removed'])
    expect(homes.get(home.homeId)).toBeUndefined()
  })

  it('remove of a home that is not there confirms without stopping anything', async () => {
    let stops = 0
    const homes = new HomeRegistry({ root, beforeRemove: async () => void stops++ })
    expect(await homes.remove(`${CRED_A}:codex`)).toEqual({ removed: false, freedBytes: 0 })
    expect(stops).toBe(0)
  })

  it('refuses to remove the default home and anything that is not a home id', async () => {
    const homes = new HomeRegistry({ root })
    await expect(homes.remove('default')).rejects.toThrow(/default/)
    await expect(homes.remove('../x:codex')).rejects.toThrow()
  })

  it('keeps the other credential of the same person when one home goes', async () => {
    const homes = new HomeRegistry({ root })
    await homes.ensure(CRED_A, 'codex')
    await homes.ensure(CRED_A, 'claude-code')
    await homes.remove(`${CRED_A}:codex`)
    expect(homes.list().map((home) => home.homeId)).toEqual([`${CRED_A}:claude-code`])
  })
})
