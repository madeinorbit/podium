import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SpecsService } from './service'

let dirs: string[] = []
function tmpRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'podium-specs-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('SpecsService (modules/specs, pspec #135)', () => {
  it('gates every proc on the repo-root allowlist', () => {
    const repo = tmpRepo()
    const svc = new SpecsService({ repoRoots: () => [repo] })
    expect(svc.list({ repoPath: repo }).some((c) => c.id === 'SP-root')).toBe(true)
    expect(() => svc.list({ repoPath: '/not/registered' })).toThrow(/known repository/)
    expect(() => svc.save({ repoPath: '/not/registered', id: 'SP-root', body: 'x' })).toThrow(
      /known repository/,
    )
  })

  it('create/save/get/search/remove round-trip through the file store', () => {
    const repo = tmpRepo()
    const svc = new SpecsService({ repoRoots: () => [repo] })
    const created = svc.create({ repoPath: repo, title: 'Retry rules', parent: 'SP-root' })
    svc.save({ repoPath: repo, id: created.id, body: '<p>retry at most twice</p>' })
    expect(svc.get({ repoPath: repo, id: created.id })?.body).toContain('twice')
    expect(svc.search({ repoPath: repo, query: 'twice' }).map((h) => h.id)).toContain(created.id)
    svc.remove({ repoPath: repo, id: created.id })
    expect(svc.get({ repoPath: repo, id: created.id })).toBeNull()
  })

  it('invoke (the relay path) zod-parses with the router-equal schema and still gates roots', async () => {
    const repo = tmpRepo()
    const svc = new SpecsService({ repoRoots: () => [repo] })
    await expect(svc.invoke('list', { repoPath: repo })).resolves.toBeTruthy()
    await expect(svc.invoke('list', {})).rejects.toThrow() // zod: repoPath required
    await expect(svc.invoke('list', { repoPath: '/elsewhere' })).rejects.toThrow(
      /known repository/,
    )
    expect(svc.invoke('nope', {})).toBeUndefined() // unknown proc → gate shapes the reply
  })
})
