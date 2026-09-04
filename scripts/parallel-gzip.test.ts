import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PIGZ_THREADS, resolvePigz, tarCompressArgs } from './parallel-gzip'

const saved = process.env.PODIUM_PIGZ

afterEach(() => {
  if (saved === undefined) delete process.env.PODIUM_PIGZ
  else process.env.PODIUM_PIGZ = saved
})

describe('resolvePigz', () => {
  it('prefers a WORKING PODIUM_PIGZ over anything on PATH', () => {
    process.env.PODIUM_PIGZ = '/somewhere/else/pigz'
    expect(resolvePigz({ probe: (candidate) => candidate === '/somewhere/else/pigz' })).toBe(
      '/somewhere/else/pigz',
    )
  })

  it('falls back to gzip when NOTHING runs — a host without pigz still builds', () => {
    delete process.env.PODIUM_PIGZ
    expect(resolvePigz({ probe: () => false })).toBeUndefined()
  })

  it('ignores a stale PODIUM_PIGZ rather than failing the release with it', () => {
    // tar --use-compress-program=/nonexistent/pigz exits 2 ("Child returned status 127"), so a
    // mistyped or stale override would break EVERY release. pigz is an optimisation: it must
    // degrade to gzip, never break the build.
    process.env.PODIUM_PIGZ = '/nonexistent/pigz'
    expect(resolvePigz({ probe: (candidate) => candidate !== '/nonexistent/pigz' })).toBe('pigz')
  })

  it('ignores an absolute fallback that exists but does not run', () => {
    delete process.env.PODIUM_PIGZ
    expect(resolvePigz({ probe: (candidate) => candidate === '/usr/bin/pigz' })).toBe(
      '/usr/bin/pigz',
    )
    expect(resolvePigz({ probe: () => false })).toBeUndefined()
  })
})

describe('tarCompressArgs', () => {
  it('falls back to tar -czf when no pigz was found', () => {
    expect(tarCompressArgs('/out.tgz', '/root', 'headless', undefined)).toEqual([
      '-czf',
      '/out.tgz',
      '-C',
      '/root',
      'headless',
    ])
  })

  it('pins the thread count to the build scope quota', () => {
    // Oversubscribing CPUQuota=200% measured SLOWER than -p2; see parallel-gzip.ts.
    expect(PIGZ_THREADS).toBe(2)
    expect(tarCompressArgs('/out.tgz', '/root', 'headless', 'pigz')[0]).toBe(
      '--use-compress-program=pigz -n -p2',
    )
  })

  it.skipIf(!resolvePigz())(
    'produces an archive plain tar -xzf extracts to identical bytes',
    () => {
      const pigz = resolvePigz()
      if (!pigz) throw new Error('unreachable: skipped when pigz is absent')
      const dir = mkdtempSync(join(tmpdir(), 'pigz-'))
      mkdirSync(join(dir, 'headless'))
      writeFileSync(join(dir, 'headless/payload'), 'x'.repeat(200_000))
      const tarball = join(dir, 'out.tgz')
      execFileSync('tar', tarCompressArgs(tarball, dir, 'headless', pigz))

      const out = join(dir, 'extracted')
      mkdirSync(out)
      execFileSync('tar', ['-xzf', tarball, '-C', out])
      expect(readFileSync(join(out, 'headless/payload'), 'utf8')).toBe(
        readFileSync(join(dir, 'headless/payload'), 'utf8'),
      )
    },
  )
})
