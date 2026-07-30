import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRPCError } from '@trpc/server'
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

  it('a REGISTERED root that does not exist on this host is a typed error, not a 500', () => {
    // A hub knows repos living on other (possibly offline) machines. Saving a
    // spec into such a root used to fall through to mkdir/write and blow up
    // with a raw fs error → INTERNAL_SERVER_ERROR with no trace.
    const ghost = '/definitely/not/on/this/machine'
    const svc = new SpecsService({ repoRoots: () => [ghost] })
    for (const call of [
      () => svc.list({ repoPath: ghost }),
      () => svc.get({ repoPath: ghost, id: 'SP-root' }),
      () => svc.save({ repoPath: ghost, id: 'SP-root', body: '<p>x</p>' }),
      () => svc.create({ repoPath: ghost, title: 'x', parent: 'SP-root' }),
      () => svc.remove({ repoPath: ghost, id: 'SP-abcd' }),
      () => svc.search({ repoPath: ghost, query: 'x' }),
    ]) {
      let caught: unknown
      try {
        call()
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(TRPCError)
      expect((caught as TRPCError).code).toBe('PRECONDITION_FAILED')
      expect((caught as TRPCError).message).toMatch(/does not exist on this machine/)
    }
  })

  it('pspec validation failures surface as BAD_REQUEST, not 500', () => {
    const repo = tmpRepo()
    const svc = new SpecsService({ repoRoots: () => [repo] })
    let caught: unknown
    try {
      svc.save({ repoPath: repo, id: 'SP-zzzz', body: '<p>x</p>' }) // unknown component
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TRPCError)
    expect((caught as TRPCError).code).toBe('BAD_REQUEST')
    expect((caught as TRPCError).message).toMatch(/not found/)
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
