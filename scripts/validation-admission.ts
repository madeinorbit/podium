const HEAVY_TEST_LOCK = 'test:heavy'
const WATCH_LOCK = 'validation:watch'
const LEASE_TTL = '30m'
const LEASE_RENEW_INTERVAL_MS = 10 * 60 * 1000

export const VALIDATION_HELD_ENV = 'PODIUM_VALIDATION_RESOURCE_HELD'
export type ValidationClass = 'focused' | 'typecheck' | 'watch' | 'heavy'
export type ValidationProcessOptions = {
  cwd: string
  env?: Record<string, string | undefined>
  label?: string
  renewIntervalMs?: number
  signal?: AbortSignal
}
type AcquireResponse = {
  data?: { granted?: unknown; alreadyHeld?: unknown; lock?: { name?: unknown } }
  text?: unknown
}
type RunControl = {
  activeProcess?: ReturnType<typeof Bun.spawn>
  interruptedExitCode?: number
}

/** Only live Podium sessions can hold the heavy/watch advisory leases. */
export function shouldAcquireValidationLease(env: Record<string, string | undefined>): boolean {
  return Boolean(env.PODIUM_SESSION_ID)
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

async function cancelWaiter(name: string, options: ValidationProcessOptions): Promise<void> {
  try {
    await runProcess(['podium', 'lock', 'cancel', name], options)
  } catch {}
}

async function acquireLease(
  name: string,
  options: ValidationProcessOptions,
  control: RunControl,
): Promise<{ exitCode: number; acquired: boolean; owned: boolean }> {
  const proc = Bun.spawn(
    [
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
    ],
    { cwd: options.cwd, env: options.env, stdio: ['inherit', 'pipe', 'inherit'] },
  )
  control.activeProcess = proc
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (control.activeProcess === proc) control.activeProcess = undefined
  if (exitCode !== 0) {
    await cancelWaiter(name, options)
    return { exitCode: control.interruptedExitCode ?? exitCode, acquired: false, owned: false }
  }

  let response: AcquireResponse | undefined
  try {
    response = JSON.parse(stdout) as AcquireResponse
  } catch {}
  const output = typeof response?.text === 'string' ? response.text : stdout.trim()
  if (output) console.log(output)
  if (
    response?.data?.granted !== true ||
    typeof response.data.alreadyHeld !== 'boolean' ||
    response.data.lock?.name !== name
  ) {
    console.error(`validation refused: '${name}' acquisition returned an invalid response`)
    await cancelWaiter(name, options)
    return { exitCode: 1, acquired: false, owned: false }
  }
  return { exitCode: 0, acquired: true, owned: response.data.alreadyHeld === false }
}

async function runWithLease(
  name: typeof HEAVY_TEST_LOCK | typeof WATCH_LOCK,
  validationClass: 'heavy' | 'watch',
  command: string[],
  options: ValidationProcessOptions,
): Promise<number> {
  const env = options.env ?? {}
  if (!shouldAcquireValidationLease(env) || env[VALIDATION_HELD_ENV] === validationClass) {
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

  let owned = false
  let renewalFailed = false
  let renewalPromise = Promise.resolve()
  let renewalTimer: ReturnType<typeof setInterval> | undefined
  try {
    if (options.signal?.aborted) return 130
    const acquisition = await acquireLease(name, options, control)
    if (!acquisition.acquired) return acquisition.exitCode || 1
    owned = acquisition.owned
    // A manually-held heavy lease is an intentional outer scope. A second
    // watch from the same session is a duplicate and remains refused.
    if (!owned && validationClass === 'watch') {
      console.error(`validation watch refused: '${WATCH_LOCK}' is already held`)
      return 1
    }

    if (owned) {
      renewalTimer = setInterval(() => {
        renewalPromise = renewalPromise.then(async () => {
          if (renewalFailed) return
          const code = await runProcess(['podium', 'lock', 'renew', name, '--ttl', LEASE_TTL], options)
          if (code === 0) return
          renewalFailed = true
          console.error(`validation stopped: could not renew '${name}'`)
          control.activeProcess?.kill()
        })
      }, options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS)
    }

    const child = spawnProcess(command, {
      ...options,
      env: {
        ...env,
        [VALIDATION_HELD_ENV]: validationClass,
        ...(validationClass === 'watch' ? { PODIUM_TEST_WORKERS: '1' } : {}),
      },
    })
    control.activeProcess = child
    let exitCode = await child.exited
    if (control.activeProcess === child) control.activeProcess = undefined
    if (control.interruptedExitCode) exitCode = control.interruptedExitCode
    else if (renewalFailed && exitCode === 0) exitCode = 1
    return exitCode
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    options.signal?.removeEventListener('abort', onAbort)
    control.activeProcess?.kill()
    if (renewalTimer) clearInterval(renewalTimer)
    await renewalPromise
    if (owned) await runProcess(['podium', 'lock', 'release', name], options)
  }
}

/** Focused tests and typecheck are lock-free; watch holds only its singleton;
 * heavyweight lanes hold only test:heavy. */
export async function runWithValidationAdmission(
  validationClass: ValidationClass,
  command: string[],
  options: ValidationProcessOptions,
): Promise<number> {
  if (command.length === 0) throw new Error('validation command is required')
  if (validationClass === 'focused' || validationClass === 'typecheck') {
    return runProcess(command, options)
  }
  return runWithLease(
    validationClass === 'watch' ? WATCH_LOCK : HEAVY_TEST_LOCK,
    validationClass,
    command,
    options,
  )
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
