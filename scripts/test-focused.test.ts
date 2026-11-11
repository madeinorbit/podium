import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executionErrors } from './test-focused'
import { LANES, laneCommand, planFiles, repositoryRoot } from './test-lanes'

const root = repositoryRoot()
const run = (args: string[]) => {
  const result = spawnSync('bun', ['run', ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined()
  return {
    code: result.status,
    output: stripVTControlCharacters(`${result.stdout}\n${result.stderr}`),
  }
}

describe('focused test execution', () => {
  let directory: string
  let passing: string
  let passingTsx: string
  let excluded: string
  let empty: string

  beforeAll(() => {
    directory = mkdtempSync(join(root, 'scripts/.focused-test-fixture-'))
    passing = join(directory, 'passing.test.ts')
    passingTsx = `${passing}x`
    excluded = join(directory, 'excluded.bench.test.ts')
    empty = join(directory, 'empty.test.ts')
    const source =
      "import { it, expect } from 'vitest'\nit('focused sentinel', () => expect(1).toBe(1))\n"
    writeFileSync(passing, source)
    writeFileSync(passingTsx, source.replace('focused sentinel', 'focused tsx sentinel'))
    writeFileSync(excluded, source)
    writeFileSync(empty, 'export {}\n')
  })

  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  it('a file that collects zero tests exits non-zero', () => {
    const result = run(['test:file', '--', excluded])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toMatch(/no tests collected|No test files found/i)
  }, 35_000)

  it('a collected file with no test cases exits non-zero', () => {
    const result = run(['test:file', '--', empty])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toMatch(/No test suite found/i)
  }, 35_000)

  it('a passing sibling cannot hide a named file that collects nothing', () => {
    const result = run(['test:file', '--', passing, excluded])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toContain(excluded)
    expect(result.output).toContain('no tests collected for named file')
  }, 35_000)

  it.each([
    'test:file',
    'test:lane',
  ])('%s rejects a name filter that executes zero tests', (wrapper) => {
    const args = wrapper === 'test:file' ? [passing] : ['node', passing]
    const result = run([wrapper, '--', ...args, '-t', '^does not match any test$'])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toContain('zero tests executed for named file')
  }, 35_000)

  it('a matching name filter executes the requested file successfully', () => {
    const result = run(['test:file', '--', passing, '-t', '^focused sentinel$'])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toMatch(/1 passed/)
  }, 35_000)

  it.each([
    ['test:file', 'ts'],
    ['test:file', 'tsx'],
    ['test:lane', 'ts'],
    ['test:lane', 'tsx'],
  ])(
    '%s selects only the named .%s file when extensions collide',
    (wrapper, extension) => {
      const file = extension === 'ts' ? passing : passingTsx
      const args = wrapper === 'test:file' ? [file] : ['node', file]
      const result = run([wrapper, '--', ...args])
      expect(result.code, result.output).toBe(0)
      expect(result.output).toMatch(/Test Files\s+1 passed\s*\(1\)/)
      expect(result.output).toMatch(/Tests\s+1 passed\s*\(1\)/)
    },
    35_000,
  )

  it('executes both extensions when both files are named', () => {
    const result = run(['test:file', '--', passing, passingTsx])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toMatch(/Test Files\s+2 passed\s*\(2\)/)
    expect(result.output).toMatch(/Tests\s+2 passed\s*\(2\)/)
  }, 35_000)

  it('preserves substring selection when the filter does not name a file', () => {
    const result = run(['test:lane', '--', 'node', passing.slice(0, -3)])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toMatch(/Test Files\s+2 passed\s*\(2\)/)
    expect(result.output).toMatch(/Tests\s+2 passed\s*\(2\)/)
  }, 35_000)

  it('still refuses extra files collected by a broader lane filter', () => {
    const result = run(['test:lane', '--', 'node', passing, directory])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toContain(`refusing to run an extra file: ${empty}`)
  }, 35_000)

  it.each([
    'apps/server/src/router.setup.test.ts',
    'apps/server/src/gateway/picture-catchup.integration.test.ts',
    'packages/pty/src/host.integration.test.ts',
    'tests/e2e/picture-catchup.e2e.test.ts',
  ])('collects exactly %s under its real config', (file) => {
    const plan = planFiles([file], root).plans[0]
    if (!plan) throw new Error('missing file plan')
    expect(plan.runner.kind).toBe('vitest')
    if (plan.runner.kind !== 'vitest') throw new Error('expected Vitest plan')
    const lane = LANES[plan.runner.lane]
    if (!lane) throw new Error('missing file lane')
    const command = laneCommand(lane, root, plan.files)
    command[command.indexOf('run')] = 'list'
    const executable = command[0]
    if (!executable) throw new Error('missing lane executable')
    const result = spawnSync(executable, [...command.slice(1), '--filesOnly', '--json'], {
      cwd: resolve(root, lane.cwd),
      env: process.env,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const files = JSON.parse(result.stdout) as { file: string }[]
    expect(files.map((entry) => relative(root, entry.file))).toEqual([file])
  }, 35_000)

  it.each([
    'bun',
    'node',
  ] as const)('preserves assertion results and mapped locations under %s', (runtime) => {
    // The supported runner selects Node for mobile paths and Bun for scripts.
    const locationDirectory =
      runtime === 'node'
        ? mkdtempSync(join(root, 'apps/mobile/src/.source-location-fixture-'))
        : directory
    try {
      const source = join(locationDirectory, 'source-location.test.ts')
      const mapped = join(locationDirectory, 'mapped.cjs')
      const original = join(locationDirectory, 'original.ts')
      writeFileSync(
        original,
        "export function fail() {\n  throw new Error('mapped external sentinel')\n}\n",
      )
      const map = Buffer.from(
        JSON.stringify({
          version: 3,
          sources: ['original.ts'],
          sourcesContent: [
            "export function fail() {\n  throw new Error('mapped external sentinel')\n}\n",
          ],
          names: [],
          // Map generated line 1 to original line 2, zero-based column 2.
          // Vitest preserves the mapped column when formatting the location.
          mappings: 'AACE',
        }),
      ).toString('base64')
      // Assign the generated location explicitly so Bun cannot remap it first:
      // this control must exercise Vitest's external-file source-map reader.
      const stack = `Error: mapped external sentinel\n    at fail (${mapped}:1:1)`
      writeFileSync(
        mapped,
        `exports.fail = function () { const error = new Error('mapped external sentinel'); error.stack = ${JSON.stringify(stack)}; throw error }\n` +
          `//# sourceMappingURL=data:application/json;base64,${map}\n`,
      )
      writeFileSync(
        source,
        String.raw`
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
const { fail } = createRequire(import.meta.url)('./mapped.cjs')
it('positive before failure', () => expect(Boolean(process.versions.bun)).toBe(${runtime === 'bun'}))
it('native frame payload failure', () => {
  try {
    expect({ payload: 'actual' }).toEqual({ payload: 'expected' })
  } catch (error) {
    // Bun can put this pseudo-location in an assertion stack. The repository
    // contains native/, so an existence-only source-map read opens a directory.
    error.stack += '\n    at new Promise (native:1:11)\n    at caller (missing-stack-source.ts:1:1)\n    at caller (malformed\0source.ts:1:1)'
    throw error
  }
})
it('mapped external failure', () => fail())
it('positive after failure', () => expect(2).toBe(2))
`,
      )
      const result = run(['test:file', '--', source])
      expect(result.code, result.output).toBe(1)
      expect(result.output).not.toContain('EISDIR')
      expect(result.output).not.toContain('Unhandled Errors')
      expect(result.output).toMatch(/Tests\s+2 failed\s*\|\s*2 passed\s*\(4\)/)
      expect(result.output).toContain('"payload": "actual"')
      expect(result.output).toContain('"payload": "expected"')
      expect(result.output).toContain('source-location.test.ts:')
      expect(result.output).toContain('original.ts:2:2')
      expect(result.output).toContain('new Promise native:1:11')
      expect(result.output).toContain('caller missing-stack-source.ts:1:1')
      expect(result.output).toContain('caller malformed\0source.ts:1:1')
      expect(result.output).toContain('mapped external sentinel')
    } finally {
      if (runtime === 'node') rmSync(locationDirectory, { recursive: true, force: true })
    }
  }, 35_000)

  it('requires an executed test in every named file', () => {
    expect(
      executionErrors(
        {
          testResults: [
            { name: passing, assertionResults: [{ status: 'passed' }] },
            { name: excluded, assertionResults: [{ status: 'pending' }, { status: 'skipped' }] },
          ],
        },
        [passing, excluded],
      ),
    ).toEqual([`zero tests executed for named file: ${excluded}`])
  })
})
