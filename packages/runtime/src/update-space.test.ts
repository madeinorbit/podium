import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateTarget } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  estimateUpdateVolumes,
  previewUpdateSpace,
  requiredUpdateSpace,
  UPDATE_SPACE_MIN_SLACK,
} from './update-space'

const GiB = 1024 ** 3
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const target: UpdateTarget = {
  version: 'next',
  critical: false,
  artifacts: {
    headless: {
      delivery: 'feed',
      platforms: {
        'linux-x86_64': {
          url: 'https://release.test/bundle.tar.gz',
          digest: 'digest',
          signature: 'sig',
        },
      },
    },
  },
}

describe('informational update space', () => {
  it('applies 30% slack with a minimum 512 MiB reserve', () => {
    expect(requiredUpdateSpace(1024)).toBe(1024 + UPDATE_SPACE_MIN_SLACK)
    expect(requiredUpdateSpace(10 * GiB)).toBe(Math.ceil(13 * GiB))
  })

  it('uses the peak overlapping phases on one volume, without summing sequential scratch files', async () => {
    const volumes = await estimateUpdateVolumes(
      [
        { path: '/install', phases: { prepare: 3 * GiB, boot: 2 * GiB } },
        { path: '/state', phases: { boot: 4 * GiB } },
      ],
      async () => ({ id: 'same', availableBytes: 7 * GiB }),
    )
    expect(volumes).toEqual([
      {
        path: '/install',
        availableBytes: 7 * GiB,
        peakBytes: 6 * GiB,
        requiredBytes: requiredUpdateSpace(6 * GiB),
        shortfallBytes: requiredUpdateSpace(6 * GiB) - 7 * GiB,
      },
    ])
  })

  it('checks separate volumes independently, including the exact warning boundary', async () => {
    const volumes = await estimateUpdateVolumes(
      [
        { path: '/install', phases: { prepare: GiB } },
        { path: '/state', phases: { boot: 4 * GiB } },
      ],
      async (path) => ({
        id: path,
        availableBytes:
          path === '/install' ? requiredUpdateSpace(GiB) : requiredUpdateSpace(4 * GiB) - 1,
      }),
    )
    expect(volumes[0]?.shortfallBytes).toBe(0)
    expect(volumes[1]?.shortfallBytes).toBe(1)
  })

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'podium-space-preview-'))
    roots.push(root)
    const installDir = join(root, 'install')
    const stateDir = join(root, 'state')
    mkdirSync(installDir)
    mkdirSync(stateDir)
    writeFileSync(join(installDir, 'payload'), 'unchanged')
    writeFileSync(join(stateDir, 'podium.db'), 'database')
    writeFileSync(join(stateDir, 'podium.db-wal'), 'wal')
    mkdirSync(`${installDir}.old`)
    writeFileSync(join(`${installDir}.old`, 'retained'), 'rollback')
    return { root, installDir, stateDir }
  }

  it('only HEADs the exact artifact and stats files; low space creates no prepared, backup or journal files', async () => {
    const f = fixture()
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'content-length': '1000' } }))
    const before = readdirSync(f.root, { recursive: true }).sort()
    const result = await previewUpdateSpace(target, {
      ...f,
      hostsServer: true,
      platform: 'linux-x86_64',
      fetch,
      filesystem: async () => ({ id: 'volume', availableBytes: 1 }),
    })
    expect(result.status).toBe('low')
    // A directory and payload block, with twice that footprint for growth.
    expect(result.volumes[0]?.peakBytes).toBe(1000 + 16384)
    expect(fetch).toHaveBeenCalledWith(
      'https://release.test/bundle.tar.gz',
      expect.objectContaining({ method: 'HEAD' }),
    )
    expect(readdirSync(f.root, { recursive: true }).sort()).toEqual(before)
    expect(readFileSync(join(f.stateDir, 'podium.db'), 'utf8')).toBe('database')
    expect(readFileSync(join(`${f.installDir}.old`, 'retained'), 'utf8')).toBe('rollback')
  })

  it('checks backup and database working space independently when their volumes differ', async () => {
    const f = fixture()
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { 'content-length': '1000' } }))
    const result = await previewUpdateSpace(target, {
      ...f,
      hostsServer: true,
      platform: 'linux-x86_64',
      fetch,
      filesystem: async (path) => ({ id: path, availableBytes: 100 * GiB }),
    })
    expect(result.status).toBe('enough')
    expect(result.volumes.find((volume) => volume.path === f.stateDir)?.peakBytes).toBe(
      'database'.length + 'wal'.length,
    )
    expect(
      result.volumes.find((volume) => volume.path === join(f.stateDir, 'podium.db'))?.peakBytes,
    ).toBe(2)
  })

  it.each([
    [4, 'low'],
    [6, 'enough'],
  ] as const)('estimates a typical update with a 3 GiB database and %i GiB free as %s', async (free, status) => {
    const f = fixture()
    // A sparse file supplies the real stat size without allocating 3 GiB.
    truncateSync(join(f.stateDir, 'podium.db'), 3 * GiB)
    const result = await previewUpdateSpace(target, {
      ...f,
      hostsServer: true,
      platform: 'linux-x86_64',
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(null, { headers: { 'content-length': String(64 * 1024 ** 2) } }),
        ),
      filesystem: async () => ({ id: 'volume', availableBytes: free * GiB }),
    })
    expect(result.status).toBe(status)
    expect(result.volumes[0]?.requiredBytes).toBeGreaterThan(4 * GiB)
    expect(result.volumes[0]?.requiredBytes).toBeLessThan(6 * GiB)
  })

  it.each([
    new Response(null, { status: 404 }),
    new Response(null),
  ])('reports missing or unknown download sizes as unknown', async (response) => {
    const f = fixture()
    const result = await previewUpdateSpace(target, {
      ...f,
      hostsServer: false,
      platform: 'linux-x86_64',
      fetch: vi.fn().mockResolvedValue(response),
    })
    expect(result.status).toBe('unknown')
    expect(result.volumes).toEqual([])
  })

  it('contains probe errors and avoids fetching when no artifact matches the platform', async () => {
    const f = fixture()
    const fetch = vi.fn().mockRejectedValue(new Error('offline'))
    expect(
      (
        await previewUpdateSpace(target, {
          ...f,
          hostsServer: false,
          platform: 'linux-x86_64',
          fetch,
        })
      ).status,
    ).toBe('unknown')
    fetch.mockClear()
    expect(
      (
        await previewUpdateSpace(target, {
          ...f,
          hostsServer: false,
          fetch,
          platform: 'not-published',
        })
      ).status,
    ).toBe('unknown')
    expect(fetch).not.toHaveBeenCalled()
  })
})
