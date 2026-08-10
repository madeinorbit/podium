import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideTestAdmission } from './test'
import {
  heldClassSatisfies,
  permitCount,
  runWithValidationAdmission,
  VALIDATION_HELD_ENV,
} from './validation-admission'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The acquire argv the wrapper builds, including its owner-pid lease stamp. */
const acquireCall = (name: string, label: string): string =>
  `lock acquire ${name} --ttl 30m --note ${label} [pid ${process.pid}] --allow-sibling --wait --json`

function fakePodium(
  options: {
    alreadyHeld?: string
    failLock?: string
    blockLock?: string
    statusLocks?: { name: string; sessionId?: string; note?: string }[]
  } = {},
): {
  env: Record<string, string | undefined>
  log: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'podium-validation-admission-'))
  tempDirs.push(dir)
  const log = join(dir, 'calls.log')
  const executable = join(dir, 'podium')
  const status = (options.statusLocks ?? []).map(({ name, sessionId, note }) => ({
    name,
    secondsLeft: 60,
    note: note ?? null,
    holder: { sessionId: sessionId ?? 'other-session' },
  }))
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$VALIDATION_LOG"
if [ "$2" = "status" ]; then
  printf '%s\\n' '${JSON.stringify({ command: 'status', ok: true, exitCode: 0, data: status })}'
elif [ "$2" = "acquire" ]; then
  if [ "$3" = "$BLOCK_LOCK" ]; then sleep 0.06; fi
  if [ "$3" = "$FAIL_LOCK" ]; then exit 9; fi
  held=false
  if [ "$3" = "$ALREADY_HELD_LOCK" ]; then held=true; fi
  printf '{"command":"acquire","ok":true,"exitCode":0,"data":{"granted":true,"alreadyHeld":%s,"lock":{"name":"%s","secondsLeft":1800}},"text":"lease granted"}\\n' "$held" "$3"
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
      FAIL_LOCK: options.failLock,
      BLOCK_LOCK: options.blockLock,
    },
  }
}

const calls = (log: string): string[] => readFileSync(log, 'utf8').trim().split('\n')

/** A pid that is certainly gone — the stamp a wrapper that died leaves behind. */
async function exitedPid(): Promise<number> {
  const proc = Bun.spawn(['bash', '-c', 'exit 0'], { stdio: ['ignore', 'ignore', 'ignore'] })
  await proc.exited
  return proc.pid
}

describe('validation resource classes', () => {
  it('weights focused/watch as one permit and typecheck/heavy as the full budget', () => {
    expect(permitCount('focused')).toBe(1)
    expect(permitCount('watch')).toBe(1)
    expect(permitCount('typecheck')).toBe(2)
    expect(permitCount('heavy')).toBe(2)
  })

  it('allows an explicit heavy marker to cover children but not a shared marker to escalate', () => {
    expect(heldClassSatisfies('heavy', 'focused')).toBe(true)
    expect(heldClassSatisfies('heavy', 'typecheck')).toBe(true)
    expect(heldClassSatisfies('focused', 'focused')).toBe(true)
    expect(heldClassSatisfies('focused', 'heavy')).toBe(false)
  })
})

describe('focused package admission', () => {
  it.each([
    ['full graph', ['--shared-admission']],
    ['arbitrary package', ['--shared-admission', '--filter', '@podium/server']],
    [
      'mixed supported and arbitrary packages',
      ['--shared-admission', '--filter=@podium/web', '--filter=@podium/server'],
    ],
  ])('refuses shared admission for $0', (_name, argv) => {
    expect(decideTestAdmission(argv)).toMatchObject({ shared: false, error: expect.any(String) })
  })

  it.each([
    ['--shared-admission', '--filter', '@podium/web'],
    ['--shared-admission', '--filter=@podium/mobile'],
    ['--shared-admission', '--filter', '@podium/web', '--filter', '@podium/mobile'],
  ])('allows the supported focused filter set: %j', (...argv) => {
    expect(decideTestAdmission(argv)).toEqual({
      shared: true,
      forwardArgs: argv.slice(1),
      error: null,
    })
  })
})

describe('runWithValidationAdmission', () => {
  it('reuses an explicit parent marker without acquiring or releasing parent leases', async () => {
    const { env, log } = fakePodium()
    env[VALIDATION_HELD_ENV] = 'heavy'
    await expect(
      runWithValidationAdmission(
        'focused',
        ['bash', '-c', `test "$${VALIDATION_HELD_ENV}" = heavy`],
        { cwd: process.cwd(), env, label: 'nested focused' },
      ),
    ).resolves.toBe(0)
    expect(existsSync(log)).toBe(false)
  })

  it('admits a focused probe on one permit and labels the visible locks', async () => {
    const { env, log } = fakePodium()
    await expect(
      runWithValidationAdmission(
        'focused',
        ['bash', '-c', `test "$${VALIDATION_HELD_ENV}" = focused`],
        {
          cwd: process.cwd(),
          env,
          label: 'focused probe',
        },
      ),
    ).resolves.toBe(0)

    expect(calls(log)).toEqual([
      'lock status --json',
      acquireCall('validation:admission', 'focused probe'),
      'lock status --json',
      acquireCall('test:heavy', 'focused probe'),
      'lock status --json',
      acquireCall('validation:shared:1', 'focused probe'),
      'lock release test:heavy',
      'lock release validation:admission',
      'lock release validation:shared:1',
    ])
  })

  it('reserves both permits for typecheck', async () => {
    const { env, log } = fakePodium()
    await expect(
      runWithValidationAdmission('typecheck', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'workspace typecheck',
      }),
    ).resolves.toBe(0)

    expect(calls(log).filter((call) => call.startsWith('lock acquire validation:shared:'))).toEqual(
      [
        acquireCall('validation:shared:1', 'workspace typecheck'),
        acquireCall('validation:shared:2', 'workspace typecheck'),
      ],
    )
    const allCalls = calls(log)
    expect(allCalls.indexOf('lock release validation:admission')).toBeGreaterThan(
      allCalls.indexOf(acquireCall('validation:shared:2', 'workspace typecheck')),
    )
  })

  it('renews the admission gate while a writer is draining permits', async () => {
    const { env, log } = fakePodium({ blockLock: 'test:heavy' })
    await expect(
      runWithValidationAdmission('typecheck', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'slow admission',
        renewIntervalMs: 10,
      }),
    ).resolves.toBe(0)

    expect(calls(log)).toContain('lock renew validation:admission --ttl 30m')
  })

  it('cancels a failed waiter and releases partial acquisition in reverse order', async () => {
    const { env, log } = fakePodium({ failLock: 'validation:shared:2' })
    await expect(
      runWithValidationAdmission('heavy', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'partial heavy',
      }),
    ).resolves.toBe(9)

    expect(calls(log).slice(-4)).toEqual([
      'lock cancel validation:shared:2',
      'lock release validation:shared:1',
      'lock release test:heavy',
      'lock release validation:admission',
    ])
  })

  it('cancels an interrupted waiter and releases partial acquisition in reverse order', async () => {
    const { env, log } = fakePodium({ blockLock: 'validation:shared:2' })
    const abort = new AbortController()
    const run = runWithValidationAdmission('heavy', ['bash', '-c', 'exit 0'], {
      cwd: process.cwd(),
      env,
      label: 'interrupted heavy',
      signal: abort.signal,
    })
    let waiterStarted = false
    for (let attempt = 0; attempt < 100; attempt++) {
      waiterStarted =
        existsSync(log) && readFileSync(log, 'utf8').includes('lock acquire validation:shared:2')
      if (waiterStarted) break
      await Bun.sleep(1)
    }
    expect(waiterStarted).toBe(true)
    abort.abort()
    await expect(run).resolves.toBe(130)

    expect(calls(log).slice(-4)).toEqual([
      'lock cancel validation:shared:2',
      'lock release validation:shared:1',
      'lock release test:heavy',
      'lock release validation:admission',
    ])
  })

  it('preserves an outer test:heavy hold and releases only leases it opened', async () => {
    const { env, log } = fakePodium({
      alreadyHeld: 'test:heavy',
      // A manual hold carries no owner-pid stamp, so it is never reclaimed.
      statusLocks: [{ name: 'test:heavy', sessionId: 'session-1', note: 'held by hand' }],
    })
    await expect(
      runWithValidationAdmission('heavy', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'outer heavy',
      }),
    ).resolves.toBe(0)

    expect(calls(log)).not.toContain('lock release test:heavy')
    expect(calls(log)).toContain('lock release validation:shared:1')
    expect(calls(log)).toContain('lock release validation:shared:2')
  })

  it('refuses a second watcher instead of making focused probes wait behind it', async () => {
    const { env, log } = fakePodium({ statusLocks: [{ name: 'validation:watch' }] })
    await expect(
      runWithValidationAdmission('watch', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'test:watch',
      }),
    ).resolves.toBe(1)

    expect(calls(log)).toEqual([
      'lock status --json',
      acquireCall('validation:admission', 'test:watch'),
      'lock status --json',
      'lock status --json',
      'lock release validation:admission',
    ])
  })

  it('forces direct watch-wrapper children to one worker', async () => {
    const { env } = fakePodium()
    env.PODIUM_TEST_WORKERS = '8'
    await expect(
      runWithValidationAdmission(
        'watch',
        ['bash', '-c', `test "$${VALIDATION_HELD_ENV}" = watch && test "$PODIUM_TEST_WORKERS" = 1`],
        { cwd: process.cwd(), env, label: 'direct watch' },
      ),
    ).resolves.toBe(0)
  })

  it('refuses overlapping validation from the same session', async () => {
    const { env, log } = fakePodium({
      statusLocks: [{ name: 'validation:shared:1', sessionId: 'session-1' }],
    })
    await expect(
      runWithValidationAdmission('focused', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'second probe',
      }),
    ).resolves.toBe(1)

    expect(calls(log)).toEqual([
      'lock status --json',
      acquireCall('validation:admission', 'second probe'),
      'lock status --json',
      'lock release validation:admission',
    ])
  })

  it('reclaims a lease stranded by a validation run that did not survive', async () => {
    const dead = await exitedPid()
    const { env, log } = fakePodium({
      statusLocks: [
        {
          name: 'validation:admission',
          sessionId: 'session-1',
          note: `workspace typecheck [pid ${dead}]`,
        },
      ],
    })
    await expect(
      runWithValidationAdmission('focused', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'after a lost run',
      }),
    ).resolves.toBe(0)

    expect(calls(log).slice(0, 3)).toEqual([
      'lock status --json',
      'lock release validation:admission',
      acquireCall('validation:admission', 'after a lost run'),
    ])
  })

  it('refuses to a live sibling run without acquiring, so retries cannot renew its lease', async () => {
    const { env, log } = fakePodium({
      statusLocks: [
        {
          name: 'validation:admission',
          sessionId: 'session-1',
          note: `workspace typecheck [pid ${process.pid}]`,
        },
      ],
    })
    await expect(
      runWithValidationAdmission('typecheck', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'overlapping typecheck',
      }),
    ).resolves.toBe(1)

    // Deciding from `status` alone is the point: an acquire here would renew the
    // very lease being refused over, and hold the queue behind it open.
    expect(calls(log)).toEqual(['lock status --json'])
  })

  it('releases a gate it refuses over instead of stranding it for the lease TTL', async () => {
    const { env, log } = fakePodium({ alreadyHeld: 'validation:admission' })
    await expect(
      runWithValidationAdmission('typecheck', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'unexpected hold',
      }),
    ).resolves.toBe(1)

    expect(calls(log)).toEqual([
      'lock status --json',
      acquireCall('validation:admission', 'unexpected hold'),
      'lock release validation:admission',
    ])
  })

  it('releases a shared permit it refuses over, not just the gate', async () => {
    // The refusal lives in the shared acquireOwned path, so every lease the
    // wrapper takes can be stranded by it — POD-680 saw it on a permit as well
    // as on the gate. Whatever a refusal took, the exit path gives back.
    const { env, log } = fakePodium({ alreadyHeld: 'validation:shared:1' })
    await expect(
      runWithValidationAdmission('focused', ['bash', '-c', 'exit 0'], {
        cwd: process.cwd(),
        env,
        label: 'unexpected permit',
      }),
    ).resolves.toBe(1)

    expect(calls(log).slice(-4)).toEqual([
      acquireCall('validation:shared:1', 'unexpected permit'),
      'lock release validation:shared:1',
      'lock release test:heavy',
      'lock release validation:admission',
    ])
  })
})
