import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideTestAdmission } from './test'
import { runWithValidationAdmission, VALIDATION_HELD_ENV } from './validation-admission'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakePodium(
  options: { alreadyHeld?: string; blockLock?: string } = {},
): { env: Record<string, string | undefined>; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'podium-validation-locks-'))
  tempDirs.push(dir)
  const log = join(dir, 'calls.log')
  const executable = join(dir, 'podium')
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\n' "$*" >> "$VALIDATION_LOG"
if [ "$2" = "acquire" ]; then
  if [ "$3" = "$BLOCK_LOCK" ]; then sleep 1; fi
  held=false
  if [ "$3" = "$ALREADY_HELD_LOCK" ]; then held=true; fi
  printf '{"data":{"granted":true,"alreadyHeld":%s,"lock":{"name":"%s"}},"text":"lease granted"}\n' "$held" "$3"
fi
`,
  )
  chmodSync(executable, 0o755)
  return {
    log,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      PODIUM_SESSION_ID: 'session-1',
      [VALIDATION_HELD_ENV]: undefined,
      VALIDATION_LOG: log,
      ALREADY_HELD_LOCK: options.alreadyHeld,
      BLOCK_LOCK: options.blockLock,
    },
  }
}

const calls = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []

describe('focused package selection', () => {
  it.each([
    ['full graph', ['--shared-admission']],
    ['arbitrary package', ['--shared-admission', '--filter', '@podium/server']],
  ])('refuses the internal focused flag for $0', (_name, argv) => {
    expect(decideTestAdmission(argv)).toMatchObject({ shared: false, error: expect.any(String) })
  })

  it.each([
    ['--shared-admission', '--filter', '@podium/web'],
    ['--shared-admission', '--filter=@podium/mobile'],
  ])('allows the supported focused filter set: %j', (...argv) => {
    expect(decideTestAdmission(argv)).toEqual({
      shared: true,
      forwardArgs: argv.slice(1),
      error: null,
    })
  })
})

describe('minimal validation locks', () => {
  it.each(['focused', 'typecheck'] as const)('%s runs without any Podium lock call', async (kind) => {
    const { env, log } = fakePodium()
    await expect(
      runWithValidationAdmission(kind, ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: kind,
      }),
    ).resolves.toBe(0)
    expect(calls(log)).toEqual([])
  })

  it('heavy acquires, marks, and releases only test:heavy', async () => {
    const { env, log } = fakePodium()
    await expect(
      runWithValidationAdmission(
        'heavy',
        ['bash', '-c', `test "$${VALIDATION_HELD_ENV}" = heavy`],
        { cwd: process.cwd(), env, label: 'heavy tests' },
      ),
    ).resolves.toBe(0)
    expect(calls(log)).toEqual([
      'lock acquire test:heavy --ttl 30m --note heavy tests --allow-sibling --wait --json',
      'lock release test:heavy',
    ])
  })

  it('preserves an intentional outer test:heavy lease', async () => {
    const { env, log } = fakePodium({ alreadyHeld: 'test:heavy' })
    await expect(
      runWithValidationAdmission('heavy', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'outer heavy',
      }),
    ).resolves.toBe(0)
    expect(calls(log)).toEqual([
      'lock acquire test:heavy --ttl 30m --note outer heavy --allow-sibling --wait --json',
    ])
  })

  it('watch holds only validation:watch and forces one worker', async () => {
    const { env, log } = fakePodium()
    env.PODIUM_TEST_WORKERS = '8'
    await expect(
      runWithValidationAdmission(
        'watch',
        [
          'bash',
          '-c',
          `test "$${VALIDATION_HELD_ENV}" = watch && test "$PODIUM_TEST_WORKERS" = 1`,
        ],
        { cwd: process.cwd(), env, label: 'test:watch' },
      ),
    ).resolves.toBe(0)
    expect(calls(log)).toEqual([
      'lock acquire validation:watch --ttl 30m --note test:watch --allow-sibling --wait --json',
      'lock release validation:watch',
    ])
  })

  it('refuses a second watch from the same session', async () => {
    const { env, log } = fakePodium({ alreadyHeld: 'validation:watch' })
    await expect(
      runWithValidationAdmission('watch', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'second watch',
      }),
    ).resolves.toBe(1)
    expect(calls(log)).toEqual([
      'lock acquire validation:watch --ttl 30m --note second watch --allow-sibling --wait --json',
    ])
  })

  it('cancels an interrupted heavy waiter without creating other leases', async () => {
    const { env, log } = fakePodium({ blockLock: 'test:heavy' })
    const abort = new AbortController()
    const run = runWithValidationAdmission('heavy', ['bash', '-c', 'exit 0'], {
      cwd: process.cwd(),
      env,
      label: 'interrupted heavy',
      signal: abort.signal,
    })
    for (let attempt = 0; attempt < 100 && calls(log).length === 0; attempt++) await Bun.sleep(1)
    abort.abort()
    await expect(run).resolves.toBe(130)
    expect(calls(log)).toEqual([
      'lock acquire test:heavy --ttl 30m --note interrupted heavy --allow-sibling --wait --json',
      'lock cancel test:heavy',
    ])
  })
})
