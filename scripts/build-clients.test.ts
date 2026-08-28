import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRunSummary, turboBuildCommand } from './build-clients'

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
