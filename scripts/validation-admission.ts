import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'

const HEAVY_TEST_LOCK = 'test:heavy'
const WATCH_LOCK = 'validation:watch'
const LEASE_TTL_MS = 30 * 60 * 1000
const LEASE_TTL = `${LEASE_TTL_MS / 60_000}m`
const LEASE_RENEW_INTERVAL_MS = 10 * 60 * 1000

export const VALIDATION_HELD_ENV = 'PODIUM_VALIDATION_RESOURCE_HELD'
export type ValidationClass = 'focused' | 'typecheck' | 'watch' | 'heavy'
export type ValidationProcessOptions = {
  cwd: string
  env?: Record<string, string | undefined>
  label?: string
  renewIntervalMs?: number
  signal?: AbortSignal
  /** Poll interval while every slot is taken. Tests shorten it; nothing else
   *  should need to, and it is never on the path of an uncontended run. */
  slotPollIntervalMs?: number
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

// ---------------------------------------------------------------------------
// The focused/typecheck slot pool
//
// WHY NOT `podium lock`. The advisory lock is strict MUTUAL EXCLUSION: one
// holder per name, enforced by the `locks` table's (repo_id, name) primary key,
// with `acquire` reducing to grant / renew / FIFO-enqueue. `--allow-sibling`
// looks like multiplicity and is not — it only waives the refusal to queue
// behind a session that shares your worktree or issue. Emulating N permits with
// N lock names would also inherit the two properties that disqualify the
// primitive here: every verb is a network call to the server (no offline path,
// and it fails rather than degrading), and a holder is identified by SESSION,
// so a lease survives the death of the process that took it until the session
// exits or the TTL is lazily swept by somebody else's acquire.
//
// A validation slot has to survive neither of those. It is a HOST-LOCAL budget
// on CPU: the holder is a process on this machine, `kill(pid, 0)` answers
// whether it is still there, and no server needs to be up for `bun run test` to
// be admitted. So the slots are files in one directory, claimed with an
// exclusive `wx` create — the same shape `TransferLock` already uses in
// apps/server for its own single-holder file lock — with the SAME TTL and
// renewal cadence as the advisory leases above so there is one answer in this
// file to "how long may a wedged holder keep a resource".
//
// NO PODIUM_SESSION_ID CARVE-OUT, deliberately. `shouldAcquireValidationLease`
// gates the heavy/watch leases on a live session because the LOCK cannot name a
// holder without one — it is a statement about identity, not a judgement that
// unsessioned work has a claim on the box. A test run started from a bare shell
// burns exactly the same cores, and 37 of the repo's 39 test scripts route
// through this lane, so exempting them would leave the limit governing almost
// nothing.
// ---------------------------------------------------------------------------

/** The pooled classes share ONE budget and one re-entrancy marker: a typecheck
 *  nested inside a focused run must not queue behind its own parent. */
const POOL_HELD = 'focused'
export const VALIDATION_SLOTS_ENV = 'PODIUM_VALIDATION_SLOTS'
export const VALIDATION_SLOT_DIR_ENV = 'PODIUM_VALIDATION_SLOT_DIR'
const SLOT_POLL_INTERVAL_MS = 250

/**
 * How many focused/typecheck runs may execute at once on this host.
 *
 * HALF THE CORES, floored, at least one. The deployment box is 8 cores and runs
 * the server, daemon and janitor continuously — roughly 1.5 cores before any
 * validation starts — so half leaves real headroom for the thing the tests are
 * being run against. It is a run limit, not a process limit: each run brings its
 * own `PODIUM_TEST_WORKERS` (2 by default), which is why the ceiling is
 * deliberately well under the core count rather than equal to it.
 *
 * `PODIUM_VALIDATION_SLOTS=off` removes the limit for a dedicated CI host that
 * has nothing else to protect; a positive integer sets it outright. Same
 * grammar as `PODIUM_TEST_WORKERS` (vitest.config.ts) minus its `auto`, which
 * there means "unbounded" and would read as "derive from cores" here.
 */
export function resolveValidationSlots(
  env: Record<string, string | undefined>,
  cpuCount: number = availableParallelism(),
): number | null {
  const configured = env[VALIDATION_SLOTS_ENV]?.trim().toLowerCase()
  if (configured === 'off') return null
  if (configured) {
    if (!/^[1-9]\d*$/.test(configured)) {
      throw new Error(`${VALIDATION_SLOTS_ENV} must be a positive integer or "off"`)
    }
    const slots = Number(configured)
    if (!Number.isSafeInteger(slots)) throw new Error(`${VALIDATION_SLOTS_ENV} is too large`)
    return slots
  }
  return Math.max(1, Math.floor(Math.max(1, cpuCount) / 2))
}

/** One directory per HOST, not per checkout: agents work in git worktrees under
 *  `.claude/worktrees/*` and every one of them competes for the same cores. */
function slotDirectory(env: Record<string, string | undefined>): string {
  return env[VALIDATION_SLOT_DIR_ENV] || join(tmpdir(), 'podium-validation-slots')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function writeSlot(path: string, note: string, exclusive: boolean): boolean {
  const holder = { pid: process.pid, note, expiresAt: Date.now() + LEASE_TTL_MS }
  try {
    writeFileSync(path, `${JSON.stringify(holder)}\n`, {
      mode: 0o600,
      flag: exclusive ? 'wx' : 'w',
    })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

/**
 * Is this slot's holder gone? Two independent answers, matching the two the
 * lease path relies on: the process is no longer running, or the lease ran out.
 * The pid check is the fast one and is only sound because the slot directory is
 * host-local; the TTL is the backstop for a wedged holder and for the vanishing
 * case of a recycled pid.
 *
 * An unreadable slot is NOT reclaimed on sight: a claim is a single small write
 * and a reader can catch it mid-flight. It becomes reclaimable once its mtime is
 * older than the TTL, which no live claim ever is.
 */
function slotIsStale(path: string): boolean {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  let holder: { pid?: unknown; expiresAt?: unknown }
  try {
    holder = JSON.parse(raw) as { pid?: unknown; expiresAt?: unknown }
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs > LEASE_TTL_MS
    } catch {
      return false
    }
  }
  if (typeof holder.pid !== 'number' || !processIsAlive(holder.pid)) return true
  return typeof holder.expiresAt !== 'number' || holder.expiresAt <= Date.now()
}

/** Take the lowest free slot, reclaiming abandoned ones as we pass them.
 *  Returns the slot's path, or null when the pool is full right now. */
function claimSlot(directory: string, slots: number, note: string): string | null {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (let index = 0; index < slots; index += 1) {
    const path = join(directory, `slot-${index}`)
    if (writeSlot(path, note, true)) return path
    if (!slotIsStale(path)) continue
    // Racy by construction — another waiter may reclaim the same corpse first —
    // which is why the re-create is still exclusive and a loss just moves on.
    rmSync(path, { force: true })
    if (writeSlot(path, note, true)) return path
  }
  return null
}

/** Is this slot file still OURS? A reclaimer that judged us dead already owns
 *  it, and both writing to it and deleting it would then hand a permit to a run
 *  nobody counted. Only reachable after a stall longer than the whole TTL, which
 *  is why a plain read-then-act is enough here. */
function slotIsOurs(path: string): boolean {
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid === process.pid
  } catch {
    return false
  }
}

function releaseSlot(path: string): void {
  if (slotIsOurs(path)) rmSync(path, { force: true })
}

/**
 * Focused suites and typecheck: capped, not serialised, and never refused.
 *
 * A run that has to wait is fine; one that errors out because the box is busy is
 * not, so a full pool polls instead of failing. On an idle host this is a single
 * exclusive create before the command starts.
 */
async function runWithSlot(
  validationClass: 'focused' | 'typecheck',
  command: string[],
  options: ValidationProcessOptions,
): Promise<number> {
  const env = options.env ?? {}
  const slots = resolveValidationSlots(env)
  if (slots === null || env[VALIDATION_HELD_ENV] === POOL_HELD) {
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

  const directory = slotDirectory(env)
  const note = options.label ?? `${validationClass} validation`
  const pollMs = options.slotPollIntervalMs ?? SLOT_POLL_INTERVAL_MS
  let slot: string | null = null
  let renewalTimer: ReturnType<typeof setInterval> | undefined
  try {
    let announced = false
    for (;;) {
      if (options.signal?.aborted || control.interruptedExitCode) {
        return control.interruptedExitCode ?? 130
      }
      slot = claimSlot(directory, slots, note)
      if (slot) break
      if (!announced) {
        announced = true
        console.error(
          `validation queued: all ${slots} validation slots are in use (${VALIDATION_SLOTS_ENV})`,
        )
      }
      await Bun.sleep(pollMs)
    }

    // Same cadence as the advisory leases: a run longer than the TTL keeps its
    // claim alive rather than being reclaimed out from under itself.
    const held = slot
    renewalTimer = setInterval(() => {
      if (slotIsOurs(held)) writeSlot(held, note, false)
    }, options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS)

    const child = spawnProcess(command, {
      ...options,
      env: { ...env, [VALIDATION_HELD_ENV]: POOL_HELD },
    })
    control.activeProcess = child
    let exitCode = await child.exited
    if (control.activeProcess === child) control.activeProcess = undefined
    if (control.interruptedExitCode) exitCode = control.interruptedExitCode
    return exitCode
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    options.signal?.removeEventListener('abort', onAbort)
    control.activeProcess?.kill()
    if (renewalTimer) clearInterval(renewalTimer)
    // Unconditional: success, failure, throw and interrupt all give the slot
    // back here. A SIGKILL that never reaches this line is what the pid and TTL
    // checks in `slotIsStale` exist for.
    if (slot) releaseSlot(slot)
  }
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

/** Focused tests and typecheck share a counting slot pool; watch holds only its
 * singleton; heavyweight lanes hold only test:heavy. */
export async function runWithValidationAdmission(
  validationClass: ValidationClass,
  command: string[],
  options: ValidationProcessOptions,
): Promise<number> {
  if (command.length === 0) throw new Error('validation command is required')
  if (validationClass === 'focused' || validationClass === 'typecheck') {
    return runWithSlot(validationClass, command, options)
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
