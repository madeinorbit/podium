import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decideTestAdmission } from './test'
import {
  resolveValidationSlots,
  runWithValidationAdmission,
  VALIDATION_HELD_ENV,
  VALIDATION_SLOT_DIR_ENV,
  VALIDATION_SLOTS_ENV,
} from './validation-admission'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function fakePodium(
  options: { alreadyHeld?: string; blockLock?: string } = {},
): { env: Record<string, string | undefined>; log: string } {
  const dir = temporaryDirectory('podium-validation-locks-')
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
      // The slot pool is host-wide by design, so every case that runs a real
      // command has to be pointed at its own directory or it would compete with
      // whatever else on this machine is running validation right now.
      [VALIDATION_SLOT_DIR_ENV]: join(dir, 'slots'),
      VALIDATION_LOG: log,
      ALREADY_HELD_LOCK: options.alreadyHeld,
      BLOCK_LOCK: options.blockLock,
    },
  }
}

const slotFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

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
    // The pool is a local file semaphore, not an advisory lease: it costs no
    // `podium lock` round trip, and it hands the slot back when the run ends.
    expect(slotFiles(env[VALIDATION_SLOT_DIR_ENV] as string)).toEqual([])
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
    // The abort has to land AFTER the acquire is in flight, so wait for the
    // fake CLI's log line rather than for a duration. The budget is generous
    // because it is only ever spent when the box is too loaded to fork quickly
    // — which is exactly when a 100ms one aborted before the acquire started
    // and the case failed on the shared host.
    for (let attempt = 0; attempt < 2000 && calls(log).length === 0; attempt++) await Bun.sleep(1)
    abort.abort()
    await expect(run).resolves.toBe(130)
    expect(calls(log)).toEqual([
      'lock acquire test:heavy --ttl 30m --note interrupted heavy --allow-sibling --wait --json',
      'lock cancel test:heavy',
    ])
  })
})

// ---------------------------------------------------------------------------
// The focused/typecheck slot pool. 37 of the repo's 39 test scripts run in this
// lane, so before it was capped the only limiter in the file governed one script
// out of thirty-nine and ~25 concurrent agent sessions could each start a run at
// once — the 8-core box was observed at load 30+.
// ---------------------------------------------------------------------------

/**
 * One measured run: it stamps its name into a shared append-only log on entry
 * and exit, so the peak below is observed from the runs themselves.
 *
 * `rendezvous` is what makes the observation deterministic instead of a race
 * against `sleep`. A run holds its slot until it can see that many `start` lines
 * — so runs that ARE allowed to overlap provably do, however loaded the machine
 * is — and gives up after a bounded wait, which is the only way a run that the
 * cap is holding back can ever appear in the log. Appends are O_APPEND from
 * separate processes and each line is far below PIPE_BUF, so the log is a true
 * total order of entries and exits.
 */
function slotRun(
  events: string,
  name: string,
  env: Record<string, string | undefined>,
  options: { rendezvous: number; exitCode?: number; waitTicks?: number },
): Promise<number> {
  const ticks = options.waitTicks ?? 100
  return runWithValidationAdmission(
    'focused',
    [
      'bash',
      '-c',
      `printf 'start %s\\n' "${name}" >> "${events}"; ` +
        `n=0; while [ "$(grep -c '^start' "${events}")" -lt ${options.rendezvous} ] && ` +
        `[ "$n" -lt ${ticks} ]; do sleep 0.02; n=$((n+1)); done; ` +
        `printf 'end %s\\n' "${name}" >> "${events}"; exit ${options.exitCode ?? 0}`,
    ],
    { cwd: process.cwd(), env, label: name, slotPollIntervalMs: 10 },
  )
}

function peakConcurrency(events: string): number {
  const lines = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : []
  let live = 0
  let peak = 0
  for (const line of lines.filter(Boolean)) {
    if (line.startsWith('start')) peak = Math.max(peak, ++live)
    else live -= 1
  }
  return peak
}

describe('focused/typecheck slot pool', () => {
  function pool(slots: string): {
    env: Record<string, string | undefined>
    dir: string
    events: string
  } {
    const dir = temporaryDirectory('podium-validation-slots-')
    return {
      dir: join(dir, 'slots'),
      events: join(dir, 'events.log'),
      env: {
        ...process.env,
        [VALIDATION_HELD_ENV]: undefined,
        [VALIDATION_SLOTS_ENV]: slots,
        [VALIDATION_SLOT_DIR_ENV]: join(dir, 'slots'),
      },
    }
  }

  it('admits at most N of N+1 concurrent runs, and queues rather than refusing', async () => {
    const { env, dir, events } = pool('2')
    // Each run waits to SEE two starts, so the two that are admitted together
    // are pinned together; the third cannot join them and only appears once one
    // has given its slot back. Uncapped, all three would rendezvous at once.
    const codes = await Promise.all(
      ['a', 'b', 'c'].map((name) => slotRun(events, name, env, { rendezvous: 2 })),
    )
    // The one that had to wait still RAN. A run refused because the box is busy
    // would be a worse failure than a slow one.
    expect(codes).toEqual([0, 0, 0])
    expect(peakConcurrency(events)).toBe(2)
    expect(slotFiles(dir)).toEqual([])
  })

  it('serialises completely at one slot, whatever the runs do', async () => {
    const { env, dir, events } = pool('1')
    // One fails, one succeeds: the slot has to come back either way, and the
    // second run would never start here if it did not. The rendezvous the first
    // run waits for can only be met by the second, so an absent cap shows up as
    // an overlap rather than as luck.
    const codes = await Promise.all([
      // A capped run only reaches the log once the other has released, so the
      // rendezvous here is never met and the wait is bounded — generously above
      // any plausible spawn latency, so a slow start cannot read as a cap.
      slotRun(events, 'fails', env, { rendezvous: 2, exitCode: 3, waitTicks: 50 }),
      slotRun(events, 'passes', env, { rendezvous: 2, waitTicks: 50 }),
    ])
    expect(codes.sort()).toEqual([0, 3])
    expect(peakConcurrency(events)).toBe(1)
    expect(slotFiles(dir)).toEqual([])
  })

  it('lets a dedicated host opt out entirely', async () => {
    const { env, dir, events } = pool('off')
    await Promise.all(['a', 'b', 'c'].map((name) => slotRun(events, name, env, { rendezvous: 3 })))
    expect(peakConcurrency(events)).toBe(3)
    expect(slotFiles(dir)).toEqual([])
  })

  it('reclaims a slot whose holder died, and one whose lease ran out', async () => {
    const { env, dir, events } = pool('2')
    mkdirSync(dir, { recursive: true })
    // A killed run leaves its file behind: nothing gets to run a `finally`.
    const corpse = Bun.spawn(['bash', '-c', 'exit 0'], { stdio: ['ignore', 'ignore', 'ignore'] })
    await corpse.exited
    writeFileSync(
      join(dir, 'slot-0'),
      `${JSON.stringify({ pid: corpse.pid, note: 'killed', expiresAt: Date.now() + 60_000 })}\n`,
    )
    // A wedged holder is still alive but has stopped renewing.
    writeFileSync(
      join(dir, 'slot-1'),
      `${JSON.stringify({ pid: process.pid, note: 'wedged', expiresAt: Date.now() - 1 })}\n`,
    )
    const codes = await Promise.all([
      slotRun(events, 'a', env, { rendezvous: 2 }),
      slotRun(events, 'b', env, { rendezvous: 2 }),
    ])
    expect(codes).toEqual([0, 0])
    expect(peakConcurrency(events)).toBe(2)
    expect(slotFiles(dir)).toEqual([])
  })

  it('renews its claim so a long run is never reclaimed under itself', async () => {
    const { env, dir } = pool('1')
    const release = join(dir, '..', 'release-the-long-run')
    // The run holds its slot until this test says so, so the sampling below can
    // never race the child's exit however slow the machine is.
    const run = runWithValidationAdmission(
      'focused',
      ['bash', '-c', `n=0; while [ ! -f "${release}" ] && [ "$n" -lt 500 ]; do sleep 0.02; n=$((n+1)); done`],
      { cwd: process.cwd(), env, label: 'long', renewIntervalMs: 10 },
    )
    const stamp = (): number | undefined => {
      try {
        return (JSON.parse(readFileSync(join(dir, 'slot-0'), 'utf8')) as { expiresAt: number })
          .expiresAt
      } catch {
        return undefined
      }
    }
    for (let attempt = 0; attempt < 500 && stamp() === undefined; attempt++) await Bun.sleep(2)
    const first = stamp() as number
    expect(first).toBeGreaterThan(0)
    for (let attempt = 0; attempt < 500 && (stamp() ?? 0) <= first; attempt++) await Bun.sleep(2)
    expect(stamp()).toBeGreaterThan(first)
    writeFileSync(release, '')
    await expect(run).resolves.toBe(0)
    expect(slotFiles(dir)).toEqual([])
  })

  it('caps runs started OUTSIDE a Podium session too', async () => {
    const { env, events } = pool('1')
    // `shouldAcquireValidationLease` exempts these from the advisory leases
    // because a lock needs a session to name its holder. A slot does not, and
    // an unsessioned run burns the same cores.
    env.PODIUM_SESSION_ID = undefined
    await Promise.all([
      slotRun(events, 'a', env, { rendezvous: 2, waitTicks: 50 }),
      slotRun(events, 'b', env, { rendezvous: 2, waitTicks: 50 }),
    ])
    expect(peakConcurrency(events)).toBe(1)
  })

  it('does not queue a nested run behind its own parent', async () => {
    const { env, dir, events } = pool('1')
    env[VALIDATION_HELD_ENV] = 'focused'
    await Promise.all([
      slotRun(events, 'a', env, { rendezvous: 2 }),
      slotRun(events, 'b', env, { rendezvous: 2 }),
    ])
    expect(peakConcurrency(events)).toBe(2)
    expect(slotFiles(dir)).toEqual([])
  })

  it.each([
    [8, 4],
    [16, 8],
    [3, 1],
    [2, 1],
    [1, 1],
  ])('defaults to half of %i cores: %i', (cores, expected) => {
    expect(resolveValidationSlots({}, cores)).toBe(expected)
  })

  it('takes an explicit override, and refuses a nonsense one', () => {
    expect(resolveValidationSlots({ [VALIDATION_SLOTS_ENV]: '6' }, 8)).toBe(6)
    expect(resolveValidationSlots({ [VALIDATION_SLOTS_ENV]: 'off' }, 8)).toBeNull()
    expect(() => resolveValidationSlots({ [VALIDATION_SLOTS_ENV]: '0' }, 8)).toThrow(
      /positive integer/,
    )
    expect(() => resolveValidationSlots({ [VALIDATION_SLOTS_ENV]: 'half' }, 8)).toThrow(
      /positive integer/,
    )
  })
})
