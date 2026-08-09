const ADMISSION_LOCK = 'validation:admission'
const HEAVY_TEST_LOCK = 'test:heavy'
const WATCH_LOCK = 'validation:watch'
const SHARED_PERMITS = ['validation:shared:1', 'validation:shared:2'] as const
const LEASE_TTL = '30m'
const LEASE_RENEW_INTERVAL_MS = 10 * 60 * 1000

export const VALIDATION_HELD_ENV = 'PODIUM_VALIDATION_RESOURCE_HELD'

export type ValidationClass = 'focused' | 'typecheck' | 'watch' | 'heavy'

export type ValidationProcessOptions = {
  cwd: string
  env?: Record<string, string | undefined>
  label?: string
  /** Test seam; production callers use the ten-minute renewal interval. */
  renewIntervalMs?: number
  signal?: AbortSignal
}

type LockWire = {
  name: string
  secondsLeft?: number
  holder?: { sessionId?: string | null }
}

type AcquireResponse = {
  data?: {
    granted?: unknown
    alreadyHeld?: unknown
    lock?: LockWire
  }
  text?: unknown
}

type Acquisition = {
  exitCode: number
  granted: boolean
  ownsLease: boolean
  lock?: LockWire
}

type RunControl = {
  activeProcess?: ReturnType<typeof Bun.spawn>
  interruptedExitCode?: number
}

/** Only live Podium sessions have an identity that can hold host-budget leases. */
export function shouldAcquireValidationLease(env: Record<string, string | undefined>): boolean {
  return Boolean(env.PODIUM_SESSION_ID)
}

export function heldClassSatisfies(held: string | undefined, requested: ValidationClass): boolean {
  if (held === 'heavy') return true
  return held === requested
}

export function permitCount(validationClass: ValidationClass): number {
  return validationClass === 'focused' || validationClass === 'watch' ? 1 : 2
}

function spawnProcess(command: string[], options: ValidationProcessOptions) {
  return Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
}

async function runProcess(command: string[], options: ValidationProcessOptions): Promise<number> {
  return spawnProcess(command, options).exited
}

async function acquireLock(
  name: string,
  options: ValidationProcessOptions,
  control: RunControl,
): Promise<Acquisition> {
  const args = [
    'podium',
    'lock',
    'acquire',
    name,
    '--ttl',
    LEASE_TTL,
    '--note',
    options.label ?? 'validation work',
    '--allow-sibling',
    '--wait',
    '--json',
  ]
  const proc = Bun.spawn(args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  control.activeProcess = proc
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (control.activeProcess === proc) control.activeProcess = undefined

  let response: AcquireResponse | undefined
  try {
    response = JSON.parse(stdout) as AcquireResponse
  } catch {}

  const output = typeof response?.text === 'string' ? response.text : stdout.trim()
  if (output) console.log(output)
  if (exitCode !== 0) {
    await cancelWaiter(name, options)
    return { exitCode, granted: false, ownsLease: false }
  }
  if (response?.data?.granted === false) {
    await cancelWaiter(name, options)
    return { exitCode: 0, granted: false, ownsLease: false }
  }
  if (
    response?.data?.granted !== true ||
    typeof response.data.alreadyHeld !== 'boolean' ||
    typeof response.data.lock?.name !== 'string'
  ) {
    console.error(
      `validation refused: '${name}' acquisition did not report whether this process owns the lease`,
    )
    await cancelWaiter(name, options)
    return { exitCode: 1, granted: false, ownsLease: false }
  }
  return {
    exitCode: 0,
    granted: true,
    ownsLease: !response.data.alreadyHeld,
    lock: response.data.lock,
  }
}

async function cancelWaiter(name: string, options: ValidationProcessOptions): Promise<void> {
  try {
    const proc = Bun.spawn(['podium', 'lock', 'cancel', name], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    await proc.exited
  } catch {}
}

async function lockStatus(
  options: ValidationProcessOptions,
): Promise<{ exitCode: number; locks: LockWire[] }> {
  const proc = Bun.spawn(['podium', 'lock', 'status', '--json'], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['inherit', 'pipe', 'inherit'],
  })
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (exitCode !== 0) return { exitCode, locks: [] }
  try {
    const response = JSON.parse(stdout) as { data?: unknown }
    if (!Array.isArray(response.data)) return { exitCode: 1, locks: [] }
    return { exitCode: 0, locks: response.data as LockWire[] }
  } catch {
    return { exitCode: 1, locks: [] }
  }
}

async function releaseOwnedLocks(
  locks: string[],
  options: ValidationProcessOptions,
): Promise<boolean> {
  let clean = true
  for (const name of [...locks].reverse()) {
    const released = await runProcess(['podium', 'lock', 'release', name], options)
    if (released === 0) {
      const index = locks.indexOf(name)
      if (index >= 0) locks.splice(index, 1)
      continue
    }
    clean = false
    console.error(
      `warning: could not release '${name}'; its ${LEASE_TTL} lease will expire automatically`,
    )
  }
  return clean
}

async function acquireOwned(
  name: string,
  options: ValidationProcessOptions,
  owned: string[],
  control: RunControl,
  settings?: { allowAlreadyHeld?: boolean },
): Promise<{ exitCode: number; granted: boolean }> {
  const acquisition = await acquireLock(name, options, control)
  if (acquisition.exitCode !== 0) {
    return { exitCode: acquisition.exitCode || 1, granted: false }
  }
  if (!acquisition.granted) return { exitCode: 0, granted: false }
  if (!acquisition.ownsLease && !settings?.allowAlreadyHeld) {
    console.error(
      `validation refused: this session already holds '${name}' without the explicit ` +
        `${VALIDATION_HELD_ENV} re-entry marker; do not overlap validation commands in one session`,
    )
    return { exitCode: 1, granted: false }
  }
  if (acquisition.ownsLease) owned.push(name)
  return { exitCode: 0, granted: true }
}

async function chooseSharedPermits(
  count: number,
  options: ValidationProcessOptions,
  owned: string[],
  control: RunControl,
): Promise<number> {
  const status = await lockStatus(options)
  if (status.exitCode !== 0) {
    console.error('validation refused: could not inspect the shared validation permits')
    return status.exitCode || 1
  }
  const held = new Map(status.locks.map((lock) => [lock.name, lock]))
  const ordered = [...SHARED_PERMITS].sort((a, b) => {
    const left = held.get(a)
    const right = held.get(b)
    if (!left && right) return -1
    if (left && !right) return 1
    return (left?.secondsLeft ?? 0) - (right?.secondsLeft ?? 0)
  })
  for (const name of ordered.slice(0, count)) {
    const acquisition = await acquireOwned(name, options, owned, control)
    if (acquisition.exitCode !== 0) return acquisition.exitCode
    if (!acquisition.granted) return 1
  }
  return 0
}

function startLeaseRenewal(
  owned: string[],
  options: ValidationProcessOptions,
  onFailure: (name: string) => void,
): {
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>
  failed: () => boolean
  stop: () => Promise<void>
} {
  let renewalFailed = false
  let renewalPromise = Promise.resolve()
  const interval = options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS
  const renewalTimer = setInterval(() => {
    renewalPromise = renewalPromise
      .then(async () => {
        if (renewalFailed) return
        for (const name of [...owned]) {
          const renewed = await runProcess(
            ['podium', 'lock', 'renew', name, '--ttl', LEASE_TTL],
            options,
          )
          if (renewed === 0) continue
          renewalFailed = true
          onFailure(name)
          break
        }
      })
      .catch(() => {
        renewalFailed = true
        onFailure('unknown validation lease')
      })
  }, interval)
  return {
    exclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
      const result = renewalPromise.then(operation)
      renewalPromise = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    failed: () => renewalFailed,
    stop: async () => {
      clearInterval(renewalTimer)
      await renewalPromise
    },
  }
}

/**
 * Run validation against a two-permit host budget.
 *
 * Focused tests consume one permit; typecheck and heavy lanes consume both. Watch
 * consumes one permit plus a singleton watch lease and refuses a second watcher.
 * Heavy lanes also retain `test:heavy` for compatibility with manual/older callers.
 */
export async function runWithValidationAdmission(
  validationClass: ValidationClass,
  command: string[],
  options: ValidationProcessOptions,
): Promise<number> {
  if (command.length === 0) throw new Error('validation command is required')
  const env = options.env ?? {}
  if (!shouldAcquireValidationLease(env)) return runProcess(command, options)

  const held = env[VALIDATION_HELD_ENV]
  if (held) {
    if (!heldClassSatisfies(held, validationClass)) {
      console.error(
        `validation refused: nested '${validationClass}' work is not covered by the held '${held}' budget`,
      )
      return 1
    }
    return runProcess(command, options)
  }

  const control: RunControl = {}
  const interrupt = (exitCode: number) => {
    control.interruptedExitCode ??= exitCode
    control.activeProcess?.kill()
  }
  const onSigint = () => interrupt(130)
  const onSigterm = () => interrupt(143)
  const onAbort = () => interrupt(130)
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  try {
    return await runAdmitted(validationClass, command, options, control)
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

async function runAdmitted(
  validationClass: ValidationClass,
  command: string[],
  options: ValidationProcessOptions,
  control: RunControl,
): Promise<number> {
  const owned: string[] = []
  let renewal: ReturnType<typeof startLeaseRenewal> | undefined
  try {
    const gate = await acquireOwned(ADMISSION_LOCK, options, owned, control)
    if (gate.exitCode !== 0 || !gate.granted) {
      return (control.interruptedExitCode ?? gate.exitCode) || 1
    }
    renewal = startLeaseRenewal(owned, options, (name) => {
      console.error(`validation stopped: could not renew '${name}'; terminating active work`)
      control.activeProcess?.kill()
    })

    const status = await lockStatus(options)
    const sessionId = options.env?.PODIUM_SESSION_ID
    if (status.exitCode !== 0) return status.exitCode || 1
    if (
      status.locks.some(
        (lock) =>
          (SHARED_PERMITS.includes(lock.name as (typeof SHARED_PERMITS)[number]) ||
            lock.name === WATCH_LOCK) &&
          lock.holder?.sessionId === sessionId,
      )
    ) {
      console.error(
        'validation refused: this session already has admitted validation work; ' +
          'run focused tests, typecheck, and the final gate one after another',
      )
      return 1
    }
    if (control.interruptedExitCode || renewal.failed()) {
      return control.interruptedExitCode ?? 1
    }

    if (validationClass === 'watch') {
      const watchStatus = await lockStatus(options)
      if (watchStatus.exitCode !== 0) return watchStatus.exitCode || 1
      if (watchStatus.locks.some((lock) => lock.name === WATCH_LOCK)) {
        console.error(
          `validation watch refused: '${WATCH_LOCK}' is already held; reuse the existing watcher instead`,
        )
        return 1
      }
      const watch = await acquireOwned(WATCH_LOCK, options, owned, control)
      if (watch.exitCode !== 0 || !watch.granted) {
        return (control.interruptedExitCode ?? watch.exitCode) || 1
      }
    }

    // Synchronize with callers that still know only the original heavy lease. An
    // outer manual test:heavy hold by this session is valid and remains caller-owned.
    const heavy = await acquireOwned(HEAVY_TEST_LOCK, options, owned, control, {
      allowAlreadyHeld: true,
    })
    if (heavy.exitCode !== 0 || !heavy.granted) {
      return (control.interruptedExitCode ?? heavy.exitCode) || 1
    }
    if (control.interruptedExitCode || renewal.failed()) {
      return control.interruptedExitCode ?? 1
    }

    const permits = await chooseSharedPermits(permitCount(validationClass), options, owned, control)
    if (permits !== 0) return control.interruptedExitCode ?? permits
    if (control.interruptedExitCode || renewal.failed()) return control.interruptedExitCode ?? 1

    if (validationClass !== 'heavy' && owned.includes(HEAVY_TEST_LOCK)) {
      const released = await renewal.exclusive(() =>
        releaseOwnedLock(HEAVY_TEST_LOCK, owned, options),
      )
      if (released !== 0) return released
    }
    const gateReleased = await renewal.exclusive(() =>
      releaseOwnedLock(ADMISSION_LOCK, owned, options),
    )
    if (gateReleased !== 0) return gateReleased
    if (control.interruptedExitCode) return control.interruptedExitCode

    const childOptions: ValidationProcessOptions = {
      ...options,
      env: {
        ...(options.env ?? {}),
        [VALIDATION_HELD_ENV]: validationClass,
        ...(validationClass === 'watch' ? { PODIUM_TEST_WORKERS: '1' } : {}),
      },
    }
    const child = spawnProcess(command, childOptions)
    control.activeProcess = child

    let exitCode = await child.exited
    if (control.activeProcess === child) control.activeProcess = undefined
    if (control.interruptedExitCode) exitCode = control.interruptedExitCode
    else if (renewal.failed() && exitCode === 0) exitCode = 1
    return exitCode
  } finally {
    control.activeProcess?.kill()
    control.activeProcess = undefined
    if (renewal) {
      await renewal.stop()
    }
    await releaseOwnedLocks(owned, options)
  }
}

async function releaseOwnedLock(
  name: string,
  owned: string[],
  options: ValidationProcessOptions,
): Promise<number> {
  const released = await runProcess(['podium', 'lock', 'release', name], options)
  if (released !== 0) return released || 1
  const index = owned.indexOf(name)
  if (index >= 0) owned.splice(index, 1)
  return 0
}

function parseCli(argv: string[]): {
  validationClass?: ValidationClass
  label?: string
  command: string[]
} {
  const validationClass = argv.shift() as ValidationClass | undefined
  let label: string | undefined
  if (argv[0] === '--label') {
    argv.shift()
    label = argv.shift()
  }
  const separator = argv.indexOf('--')
  return { validationClass, label, command: separator >= 0 ? argv.slice(separator + 1) : argv }
}

async function main() {
  const parsed = parseCli(process.argv.slice(2))
  if (
    !parsed.validationClass ||
    !['focused', 'typecheck', 'watch', 'heavy'].includes(parsed.validationClass)
  ) {
    console.error(
      'usage: bun scripts/validation-admission.ts <focused|typecheck|watch|heavy> ' +
        '[--label <name>] -- <command> [args...]',
    )
    process.exit(2)
  }
  process.exit(
    await runWithValidationAdmission(parsed.validationClass, parsed.command, {
      cwd: process.cwd(),
      env: process.env,
      label: parsed.label,
    }),
  )
}

if (import.meta.main) await main()
