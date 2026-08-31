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
  it('prefers PODIUM_PIGZ over anything on PATH', () => {
    process.env.PODIUM_PIGZ = '/somewhere/else/pigz'
    expect(resolvePigz()).toBe('/somewhere/else/pigz')
  })

  it('returns undefined rather than throwing when pigz is absent — it is an optimisation', () => {
    // An empty PATH with no PODIUM_PIGZ is the "host without pigz" case. The absolute
    // fallbacks are still probed, so only assert the type: undefined or a real path.
    process.env.PODIUM_PIGZ = ''
    const resolved = resolvePigz()
    expect(resolved === undefined || typeof resolved === 'string').toBe(true)
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

  it('produces an archive plain tar -xzf extracts to identical bytes', () => {
    const pigz = resolvePigz()
    if (!pigz) return // a host without pigz exercises the gzip path above instead
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
  })
})
