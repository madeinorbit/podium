import { join } from 'node:path'

const HEAVY_TEST_LOCK = 'test:heavy'
const HEAVY_TEST_LOCK_TTL = '30m'
const HEAVY_TEST_RENEW_INTERVAL_MS = 10 * 60 * 1000

export type TestProcessOptions = {
  cwd: string
  env?: Record<string, string | undefined>
}

/** Only live Podium sessions have an identity that can hold the shared lease. */
export function shouldAcquireHeavyTestLease(env: Record<string, string | undefined>): boolean {
  return Boolean(env.PODIUM_SESSION_ID)
}

function spawnProcess(command: string[], options: TestProcessOptions) {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  return proc
}

async function runProcess(command: string[], options: TestProcessOptions): Promise<number> {
  return spawnProcess(command, options).exited
}

type HeavyTestLeaseAcquisition = {
  exitCode: number
  /** True only when this invocation created the hold it must later release. */
  ownsLease: boolean
}

async function acquireHeavyTestLease(
  options: TestProcessOptions,
): Promise<HeavyTestLeaseAcquisition> {
  const proc = Bun.spawn(
    [
      'podium',
      'lock',
      'acquire',
      HEAVY_TEST_LOCK,
      '--ttl',
      HEAVY_TEST_LOCK_TTL,
      '--wait',
      '--json',
    ],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: ['inherit', 'pipe', 'inherit'],
    },
  )
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])

  let response:
    | {
        data?: { granted?: unknown; alreadyHeld?: unknown }
        text?: unknown
      }
    | undefined
  try {
    response = JSON.parse(stdout) as typeof response
  } catch {}

  const output = typeof response?.text === 'string' ? response.text : stdout.trim()
  if (output) console.log(output)
  if (exitCode !== 0) return { exitCode, ownsLease: false }

  if (response?.data?.granted !== true || typeof response.data.alreadyHeld !== 'boolean') {
    console.error(
      'test run refused: ' +
        HEAVY_TEST_LOCK +
        ' acquisition did not report whether this process owns the lease',
    )
    return { exitCode: 1, ownsLease: false }
  }

  return { exitCode: 0, ownsLease: !response.data.alreadyHeld }
}

/** Serialize resource-heavy test commands when invoked from a live session. */
export async function runWithHeavyTestLease(
  command: string[],
  options: TestProcessOptions,
): Promise<number> {
  if (command.length === 0) throw new Error('test command is required')
  if (!shouldAcquireHeavyTestLease(options.env ?? {})) return runProcess(command, options)

  const acquisition = await acquireHeavyTestLease(options)
  if (acquisition.exitCode !== 0) {
    console.error(
      'test run refused: could not acquire ' +
        HEAVY_TEST_LOCK +
        '; the shared host was not tested without its resource lease',
    )
    return acquisition.exitCode || 1
  }

  let exitCode = 1
  let testProcess: ReturnType<typeof spawnProcess> | undefined
  try {
    testProcess = spawnProcess(command, options)
  } catch (error) {
    if (acquisition.ownsLease) {
      await runProcess(['podium', 'lock', 'release', HEAVY_TEST_LOCK], options)
    }
    throw error
  }
  if (!testProcess) throw new Error('test process was not started')

  let leaseRenewalFailed = false
  let renewalPromise = Promise.resolve()
  const renewalTimer = setInterval(() => {
    renewalPromise = renewalPromise
      .then(async () => {
        const renewed = await runProcess(
          ['podium', 'lock', 'renew', HEAVY_TEST_LOCK, '--ttl', HEAVY_TEST_LOCK_TTL],
          options,
        )
        if (renewed === 0) return
        leaseRenewalFailed = true
        console.error(
          'test run stopped: could not renew ' +
            HEAVY_TEST_LOCK +
            '; the test process is being terminated to avoid an unleased run',
        )
        testProcess?.kill()
      })
      .catch(() => {
        leaseRenewalFailed = true
        console.error(
          'test run stopped: lease renewal failed; ' +
            HEAVY_TEST_LOCK +
            ' is being terminated to avoid an unleased run',
        )
        testProcess?.kill()
      })
  }, HEAVY_TEST_RENEW_INTERVAL_MS)

  try {
    exitCode = await testProcess.exited
  } finally {
    clearInterval(renewalTimer)
    await renewalPromise
    if (leaseRenewalFailed && exitCode === 0) exitCode = 1
    if (acquisition.ownsLease) {
      const released = await runProcess(['podium', 'lock', 'release', HEAVY_TEST_LOCK], options)
      if (released !== 0) {
        console.error(
          'warning: could not release ' +
            HEAVY_TEST_LOCK +
            '; its ' +
            HEAVY_TEST_LOCK_TTL +
            ' lease will expire automatically',
        )
      }
    }
  }
  return exitCode
}

async function main() {
  const args = process.argv.slice(2)
  const separator = args.indexOf('--')
  const command = separator >= 0 ? args.slice(separator + 1) : args
  if (command.length === 0) {
    console.error('usage: bun scripts/test-heavy.ts -- <command> [args...]')
    process.exit(2)
  }

  const root = join(import.meta.dir, '..')
  process.exit(await runWithHeavyTestLease(command, { cwd: root, env: process.env }))
}

if (import.meta.main) await main()
