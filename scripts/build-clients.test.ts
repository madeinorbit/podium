import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLIENT_DIST_DIRS,
  readRunSummary,
  stampClients,
  stampCommandFor,
  turboBuildCommand,
} from './build-clients'

function summaryFixture(name: string, tasks: unknown): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'podium-run-summary-'))
  mkdirSync(join(root, '.turbo', 'runs'), { recursive: true })
  const path = join(root, '.turbo', 'runs', name)
  writeFileSync(path, JSON.stringify({ tasks }))
  return { root, path }
}

describe('readRunSummary', () => {
  it('extracts hash and cache status for both client tasks', () => {
    const { root, path } = summaryFixture('r1.json', [
      { taskId: '@podium/web#build', hash: 'aaa', cache: { status: 'HIT', source: 'LOCAL' } },
      { taskId: '@podium/mobile#build', hash: 'bbb', cache: { status: 'MISS' } },
    ])
    expect(readRunSummary(root, path)).toEqual({
      '@podium/web#build': { hash: 'aaa', cache: 'HIT' },
      '@podium/mobile#build': { hash: 'bbb', cache: 'MISS' },
    })
  })

  it('refuses a summary that does not name both tasks', () => {
    // A lane that reports success while one client never built is exactly the
    // failure this wrapper exists to catch: the packaging step downstream would
    // take a dist from a previous run as this run's output.
    const { root, path } = summaryFixture('r2.json', [
      { taskId: '@podium/web#build', hash: 'aaa', cache: { status: 'HIT' } },
    ])
    expect(() => readRunSummary(root, path)).toThrow(/@podium\/mobile#build did not run/)
  })

  it('refuses a task whose cache status it does not understand', () => {
    const { root, path } = summaryFixture('r3.json', [
      { taskId: '@podium/web#build', hash: 'aaa', cache: { status: 'HIT' } },
      { taskId: '@podium/mobile#build', hash: 'bbb', cache: { status: 'SOMETHING' } },
    ])
    expect(() => readRunSummary(root, path)).toThrow(/@podium\/mobile#build did not run/)
  })
})

describe('turboBuildCommand', () => {
  it('is turbo run build, both client filters, summarize, no force', () => {
    expect(turboBuildCommand('/r', [])).toEqual([
      '/r/node_modules/.bin/turbo',
      'run',
      'build',
      '--filter=@podium/web',
      '--filter=@podium/mobile',
      '--summarize',
      '--concurrency=1',
    ])
  })

  it('forwards the caller arguments after its own', () => {
    expect(turboBuildCommand('/r', ['--force'])).toContain('--force')
  })
})

/**
 * THE RE-STAMP IS THE FIX FOR POD-3072, SO ITS WIRING IS TESTED, NOT ASSUMED.
 *
 * The claim the release depends on is that BOTH clients go through it — a fix that
 * re-stamped only the desktop dist would leave `verify-client-build` refusing the phone
 * on exactly the same sentence, and a green web half is the most convincing way to miss
 * that. So these drive `stampClients` against a stand-in stamp script and read back what
 * it was actually asked to do.
 */
describe('stampCommandFor', () => {
  it('spawns the same script, interpreter and condition the package build step does', () => {
    // `--conditions=@podium/source` is load-bearing: without it `@podium/model` resolves
    // to a built dist (or another checkout), and write-web-build-stamp.ts refuses rather
    // than fingerprint a wire nobody is serving (POD-746).
    expect(stampCommandFor('/r', 'apps/web/dist')).toEqual([
      process.execPath,
      '--conditions=@podium/source',
      '/r/scripts/write-web-build-stamp.ts',
      '/r/apps/web/dist',
    ])
  })

  it('names both client dists, so the phone is stamped by the same path as the desktop', () => {
    expect([...CLIENT_DIST_DIRS]).toEqual(['apps/web/dist', 'apps/mobile/dist'])
  })
})

/** A root whose `scripts/write-web-build-stamp.ts` is a recorder, not the real stamp. */
function recordingRoot(exitCode = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'podium-stamp-lane-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  const script = join(root, 'scripts', 'write-web-build-stamp.ts')
  writeFileSync(
    script,
    'import { appendFileSync } from "node:fs"\n' +
      `appendFileSync(${JSON.stringify(join(root, 'stamped.log'))}, process.argv[2] + "\\n")\n` +
      `process.exit(${exitCode})\n`,
  )
  chmodSync(script, 0o644)
  return root
}

describe('stampClients', () => {
  it('stamps both client dists, in the order the lane writes them', async () => {
    const root = recordingRoot()
    await stampClients(root, process.env)
    expect(readFileSync(join(root, 'stamped.log'), 'utf8').trim().split('\n')).toEqual([
      join(root, 'apps/web/dist'),
      join(root, 'apps/mobile/dist'),
    ])
  })

  it('refuses the run when a stamp fails instead of returning an unstamped dist', async () => {
    // A swallowed failure here is the POD-3072 bug wearing a green: packaging would go
    // on to verify a dist still naming the commit the cache was filled from.
    const root = recordingRoot(1)
    await expect(stampClients(root, process.env)).rejects.toThrow(
      /stamping apps\/web\/dist exited 1/,
    )
    // It stopped at the first failure rather than pressing on to the phone.
    expect(readFileSync(join(root, 'stamped.log'), 'utf8').trim().split('\n')).toEqual([
      join(root, 'apps/web/dist'),
    ])
  })
})
