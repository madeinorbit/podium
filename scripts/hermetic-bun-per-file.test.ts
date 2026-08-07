/**
 * Regression for POD-553: multi-file `bun test` must not share one PODIUM_STATE_DIR / TMPDIR.
 *
 * A bun preload evaluates once per process; without a per-file remint, every file after the
 * first inherits the first file's roots. This spawns a real two-file `bun test` under the
 * repo bunfig so the preload + hooks are the ones production lanes use.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const PROBE = `import { describe, it, expect } from 'bun:test'
describe('probe', () => {
  it('reports roots', () => {
    console.log(
      'PROBE ' +
        __PROBE_LABEL__ +
        ' pid=' +
        process.pid +
        ' state=' +
        process.env.PODIUM_STATE_DIR +
        ' tmp=' +
        process.env.TMPDIR,
    )
    expect(process.env.PODIUM_STATE_DIR).toBeTruthy()
    expect(process.env.TMPDIR).toBeTruthy()
  })
})
`

describe('bun multi-file hermetic roots [POD-553]', () => {
  let probeDir: string | undefined

  afterEach(() => {
    if (probeDir) {
      rmSync(probeDir, { recursive: true, force: true })
      probeDir = undefined
    }
  })

  it('gives each test file its own state root and tmp container in one invocation', () => {
    probeDir = mkdtempSync(join(tmpdir(), 'podium-553-probe-'))
    const one = join(probeDir, 'one.bun.test.ts')
    const two = join(probeDir, 'two.bun.test.ts')
    writeFileSync(one, PROBE.replaceAll('__PROBE_LABEL__', JSON.stringify('one')))
    writeFileSync(two, PROBE.replaceAll('__PROBE_LABEL__', JSON.stringify('two')))

    // cwd = repo root so bunfig.toml preload (test-hermetic-env + bun hooks) applies.
    // Drop this vitest file's hermetic roots so the child bun process mints its own — the
    // bug under test is sharing *within* one bun invocation, not inheriting the parent.
    const childEnv = { ...process.env }
    delete childEnv.PODIUM_STATE_DIR
    delete childEnv.TMPDIR
    delete childEnv.PODIUM_TEST_HOST_TMPDIR
    const result = spawnSync(
      'bun',
      ['test', '--conditions=@podium/source', one, two],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: childEnv,
      },
    )
    const output = `${result.stdout}\n${result.stderr}`
    expect(result.status, output).toBe(0)

    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('PROBE '))
    expect(lines.length, output).toBe(2)

    const parsed = lines.map((line) => {
      const m = line.match(/^PROBE (\S+) pid=(\d+) state=(\S+) tmp=(\S+)$/)
      expect(m, line).toBeTruthy()
      // Narrow the captures HERE, not at each use: every group in the pattern is
      // mandatory, so a truthy match captured all four. Without this the fields stay
      // `string | undefined` and the `.startsWith()` calls below do not compile.
      return { label: m![1]!, pid: m![2]!, state: m![3]!, tmp: m![4]! }
    })
    expect(parsed[0]!.label).toBe('one')
    expect(parsed[1]!.label).toBe('two')
    // Same process (the bug surface): if bun ever forks per file, this assertion still
    // holds for isolation; the distinct roots are what we require either way.
    expect(parsed[0]!.state).not.toBe(parsed[1]!.state)
    expect(parsed[0]!.tmp).not.toBe(parsed[1]!.tmp)
    // State lives inside its file's tmp container (mint layout).
    expect(parsed[0]!.state.startsWith(parsed[0]!.tmp + '/')).toBe(true)
    expect(parsed[1]!.state.startsWith(parsed[1]!.tmp + '/')).toBe(true)
  })
})
