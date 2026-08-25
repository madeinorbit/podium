import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runReclaimDiskEstimateJob } from './reclaim-disk-estimate'

const DU_TOLERANCE_BYTES = 4096
const temporary: string[] = []

const allocatedBytes = (path: string): number =>
  Number.parseInt(
    execFileSync('du', ['--summarize', '--block-size=1', path], { encoding: 'utf8' }).split(
      /\s/,
    )[0]!,
    10,
  )

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('runReclaimDiskEstimateJob', () => {
  it('matches before-minus-after du across nested roots and shared hardlinks', async () => {
    const main = mkdtempSync(join(tmpdir(), 'podium-reclaim-estimate-'))
    temporary.push(main)
    const worktrees = join(main, '.worktrees')
    const freeA = join(worktrees, 'free-a')
    const freeB = join(worktrees, 'free-b')
    mkdirSync(join(main, 'node_modules/pkg'), { recursive: true })
    mkdirSync(join(freeA, 'node_modules/pkg'), { recursive: true })
    mkdirSync(join(freeB, 'node_modules/pkg'), { recursive: true })

    const shared = join(main, 'node_modules/pkg/shared.bin')
    writeFileSync(shared, Buffer.alloc(96 * 1024, 1))
    linkSync(shared, join(freeA, 'node_modules/pkg/shared.bin'))
    linkSync(shared, join(freeB, 'node_modules/pkg/shared.bin'))

    const reclaimOnly = join(freeA, 'reclaim-only.bin')
    writeFileSync(reclaimOnly, Buffer.alloc(128 * 1024, 2))
    linkSync(reclaimOnly, join(freeB, 'reclaim-only.bin'))
    writeFileSync(join(freeA, 'unique-a.bin'), Buffer.alloc(48 * 1024, 3))
    writeFileSync(join(freeB, 'unique-b.bin'), Buffer.alloc(80 * 1024, 4))
    writeFileSync(join(main, 'retained.bin'), Buffer.alloc(64 * 1024, 5))

    const before = allocatedBytes(main)
    const estimate = await runReclaimDiskEstimateJob({
      roots: [main, freeA, freeB],
      reclaimRoots: [freeA, freeB],
    })
    rmSync(freeA, { recursive: true })
    rmSync(freeB, { recursive: true })
    const independentlyRecovered = before - allocatedBytes(main)

    expect(Math.abs(estimate.recoverableBytes - independentlyRecovered)).toBeLessThanOrEqual(
      DU_TOLERANCE_BYTES,
    )
    // The retained hardlink is not promised as recovered; the reclaim-only
    // hardlink is counted once even though two directory entries disappear.
    expect(estimate.recoverableBytes).toBeGreaterThan(128 * 1024)
    expect(estimate.recoverableBytes).toBeLessThan(400 * 1024)
  })
})
