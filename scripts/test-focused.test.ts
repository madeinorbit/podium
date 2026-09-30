import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
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
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` }
}

describe('focused test execution', () => {
  let directory: string
  let passing: string
  let excluded: string
  let empty: string

  beforeAll(() => {
    directory = mkdtempSync(join(root, 'scripts/.focused-test-fixture-'))
    passing = join(directory, 'passing.test.ts')
    excluded = join(directory, 'excluded.bench.test.ts')
    empty = join(directory, 'empty.test.ts')
    const source =
      "import { it, expect } from 'vitest'\nit('focused sentinel', () => expect(1).toBe(1))\n"
    writeFileSync(passing, source)
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
