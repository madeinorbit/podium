/** Exact-file collection and execution checks, inside the lane's admission. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Lane, laneCommand } from './test-lanes'
import { runWithValidationAdmission } from './validation-admission'

interface Request {
  command: string[]
  files: string[]
  label: string
}

interface TestReport {
  testResults?: { name: string; assertionResults?: { status: string }[] }[]
}

export function executionErrors(report: TestReport, files: string[]): string[] {
  const executed = new Set<string>()
  for (const result of report.testResults ?? []) {
    if (result.assertionResults?.some(({ status }) => status === 'passed' || status === 'failed'))
      executed.add(resolve(result.name))
  }
  if (files.length === 0) return executed.size === 0 ? ['zero tests executed'] : []
  return files
    .filter((file) => !executed.has(resolve(file)))
    .map((file) => `zero tests executed for named file: ${file}`)
}

export async function runFocusedVitest(
  lane: Lane,
  root: string,
  extra: string[],
  files: string[],
  label: string,
): Promise<number> {
  const cwd = resolve(root, lane.cwd)
  const request: Request = {
    command: laneCommand(lane, root, extra),
    files: files.map((file) => resolve(cwd, file)),
    label,
  }
  return runWithValidationAdmission(
    lane.admission,
    ['bun', join(root, 'scripts/test-focused.ts'), JSON.stringify(request)],
    { cwd, label, env: process.env },
  )
}

async function run(request: Request): Promise<number> {
  // Help is informational and cannot supply an execution report.
  if (request.command.some((arg) => arg === '--help' || arg === '-h'))
    return Bun.spawn(request.command, { stdio: ['inherit', 'inherit', 'inherit'] }).exited

  const directory = mkdtempSync(join(tmpdir(), 'podium-focused-tests-'))
  let active: { kill(signal: 'SIGINT' | 'SIGTERM'): void } | undefined
  let interrupted: number | undefined
  const onSigint = () => {
    interrupted = 130
    active?.kill('SIGINT')
  }
  const onSigterm = () => {
    interrupted = 143
    active?.kill('SIGTERM')
  }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  const spawn = async (command: string[]) => {
    const child = Bun.spawn(command, { stdio: ['inherit', 'inherit', 'inherit'] })
    active = child
    try {
      const code = await child.exited
      return interrupted ?? code
    } finally {
      active = undefined
    }
  }
  try {
    if (request.files.length > 0) {
      const list = [...request.command]
      list[list.indexOf('run')] = 'list'
      const listPath = join(directory, 'files.json')
      const code = await spawn([...list, '--filesOnly', `--json=${listPath}`])
      if (code !== 0) return code
      const collected = JSON.parse(readFileSync(listPath, 'utf8')) as { file: string }[]
      const found = new Set(collected.map(({ file }) => resolve(file)))
      const wanted = new Set(request.files)
      const errors = [
        ...request.files
          .filter((file) => !found.has(file))
          .map((file) => `no tests collected for named file: ${file}`),
        ...[...found]
          .filter((file) => !wanted.has(file))
          .map((file) => `refusing to run an extra file: ${file}`),
      ]
      if (errors.length > 0) {
        for (const error of errors) console.error(`${request.label}: ${error}`)
        return 1
      }
    }
    const reportPath = join(directory, 'results.json')
    const hasReporter = request.command.some((arg) => /^--reporter(s)?(=|$)/.test(arg))
    const code = await spawn([
      ...request.command,
      ...(hasReporter ? [] : ['--reporter=default']),
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
    ])
    if (code !== 0) return code
    const errors = executionErrors(JSON.parse(readFileSync(reportPath, 'utf8')), request.files)
    for (const error of errors) console.error(`${request.label}: ${error}`)
    return errors.length > 0 ? 1 : 0
  } catch (error) {
    console.error(`${request.label}: cannot verify test execution: ${error}`)
    return 1
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    active?.kill('SIGTERM')
    rmSync(directory, { recursive: true, force: true })
  }
}

if (import.meta.main) process.exit(await run(JSON.parse(process.argv[2] as string)))
