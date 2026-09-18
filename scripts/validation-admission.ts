import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism, homedir, hostname, totalmem } from 'node:os'
import { join } from 'node:path'
import { assertBunToolchain } from './bun-toolchain'

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
export const VALIDATION_BUDGET_MB_ENV = 'PODIUM_VALIDATION_BUDGET_MB'

/**
 * What one admitted run COSTS, in MB of peak RSS. The pool is sized and charged
 * in this unit because RAM, not CPU, is what runs out first on a shared box.
 *
 * typecheck: one `tsgo --noEmit` on apps/server or apps/web peaks at 2.6GB cold
 * in the main checkout and 4.1GB in a fresh worktree (measured 2026-09-11; the
 * 817MB figure from 2026-07 was stale by a factor of three). scripts/typecheck.ts
 * pins turbo to one compiler per run, so a run costs one compiler.
 *
 * focused: one vitest lane with the single worker the pool pins it to (below).
 * apps/server lanes are the expensive ones — transform and import of the server
 * graph dominates — and were measured at ~1.3GB with two workers.
 */
export const VALIDATION_COST_MB = { typecheck: 3000, focused: 1000 } as const

/** The share of the host's memory ceiling the pool may spend. The other half is
 *  for what the tests are being run AGAINST: the server, the daemon, and the
 *  resident agent sessions, which on an agent box are several GB of idle CLIs
 *  before any validation starts. A fraction rather than a constant so it scales
 *  from a 4GB laptop to a 64GB CI host. */
const BUDGET_FRACTION = 0.5

const CHEAPEST_COST_MB = Math.min(...Object.values(VALIDATION_COST_MB))

/**
 * The memory ceiling this process actually lives under, in MB: the tightest
 * finite `memory.max` on its cgroup v2 ancestry, else physical RAM. A Podium
 * session on a systemd host runs inside a slice (podium-sessions.slice) whose
 * cap is well below the box's RAM, and sizing the pool from the box would admit
 * runs the slice then kills at exit 137. Non-Linux hosts and cgroup v1 fall
 * through to `totalmem()`.
 */
export function hostMemoryCeilingMb(
  io: { read: (path: string) => string; totalMb: number } = {
    read: (path) => readFileSync(path, 'utf8'),
    totalMb: Math.floor(totalmem() / 1_048_576),
  },
): number {
  let ceiling = io.totalMb
  let cgroupPath: string | undefined
  try {
    cgroupPath = io
      .read('/proc/self/cgroup')
      .split('\n')
      .find((line) => line.startsWith('0::'))
      ?.slice(3)
      .trim()
  } catch {
    return ceiling
  }
  if (cgroupPath === undefined) return ceiling
  const segments = cgroupPath.split('/').filter(Boolean)
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const path = ['/sys/fs/cgroup', ...segments.slice(0, depth), 'memory.max'].join('/')
    let raw: string
    try {
      raw = io.read(path).trim()
    } catch {
      continue
    }
    if (raw === 'max' || !/^\d+$/.test(raw)) continue
    ceiling = Math.min(ceiling, Math.floor(Number(raw) / 1_048_576))
  }
  return ceiling
}

/** MB the pool may have in flight at once. `PODIUM_VALIDATION_BUDGET_MB` sets it
 *  outright; the default is {@link BUDGET_FRACTION} of {@link hostMemoryCeilingMb}. */
export function resolveValidationBudgetMb(
  env: Record<string, string | undefined>,
  ceilingMb: number = hostMemoryCeilingMb(),
): number {
  const configured = env[VALIDATION_BUDGET_MB_ENV]?.trim()
  if (configured) {
    if (!/^[1-9]\d*$/.test(configured)) {
      throw new Error(`${VALIDATION_BUDGET_MB_ENV} must be a positive integer`)
    }
    const budget = Number(configured)
    if (!Number.isSafeInteger(budget)) throw new Error(`${VALIDATION_BUDGET_MB_ENV} is too large`)
    return budget
  }
  return Math.floor(ceilingMb * BUDGET_FRACTION)
}

/**
 * How many focused/typecheck runs may execute at once on this host.
 *
 * The smaller of two ceilings, at least one:
 *  - half the cores, floored. Each run brings its own worker(s), which is why
 *    this sits well under the core count rather than equal to it.
 *  - the memory budget divided by the cheapest run. This is the one that binds
 *    on an agent box: 8 cores would allow four runs, and four 3GB compilers is
 *    12GB into a 16GB slice that already holds 9GB of resident sessions.
 * The count is the number of slot files, a hard cap; what a run actually costs
 * is charged separately at claim time (see {@link claimSlot}), so a typecheck
 * and a focused lane are not the same weight even though each takes one file.
 *
 * `PODIUM_VALIDATION_SLOTS=off` removes the limit for a dedicated CI host that
 * has nothing else to protect; a positive integer sets the count outright. Same
 * grammar as `PODIUM_TEST_WORKERS` (vitest.config.ts) minus its `auto`, which
 * there means "unbounded" and would read as "derive from cores" here.
 */
export function resolveValidationSlots(
  env: Record<string, string | undefined>,
  cpuCount: number = availableParallelism(),
  budgetMb?: number,
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
  const byCores = Math.floor(Math.max(1, cpuCount) / 2)
  const byMemory =
    budgetMb === undefined ? Number.POSITIVE_INFINITY : Math.floor(budgetMb / CHEAPEST_COST_MB)
  return Math.max(1, Math.min(byCores, byMemory))
}

/** One directory per user and host, independent of checkout and task TMPDIR.
 *  Include the hostname because a home directory may be shared between hosts.
 *  The explicit override is reserved for deliberate pool isolation. */
function slotDirectory(env: Record<string, string | undefined>): string {
  return env[VALIDATION_SLOT_DIR_ENV] || join(homedir(), '.cache', 'podium', hostname(), 'validation-slots')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function writeSlot(path: string, note: string, costMb: number, exclusive: boolean): boolean {
  const holder = { pid: process.pid, note, costMb, expiresAt: Date.now() + LEASE_TTL_MS }
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

/** MB charged by the holders of the given slot files that are still live.
 *  A slot written before costs were recorded is charged the cheapest run. */
function heldCostMb(directory: string, slots: number): number {
  let held = 0
  for (let index = 0; index < slots; index += 1) {
    const path = join(directory, `slot-${index}`)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      // No file is no holder. Anything else unreadable is a claim caught
      // mid-write: charge it the cheapest run rather than nothing —
      // under-counting is how the box dies.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') held += CHEAPEST_COST_MB
      continue
    }
    if (slotIsStale(path)) continue
    try {
      const holder = JSON.parse(raw) as { costMb?: unknown }
      held += typeof holder.costMb === 'number' ? holder.costMb : CHEAPEST_COST_MB
    } catch {
      held += CHEAPEST_COST_MB
    }
  }
  return held
}

/**
 * Take the lowest free slot, reclaiming abandoned ones as we pass them, but
 * only if this run's cost still fits under the budget next to the live holders.
 * Returns the slot's path, or null when the pool is full right now.
 *
 * The budget check is read-then-claim, so two waiters that both see room can
 * both take it; the slot COUNT is the hard cap that bounds that over-admission
 * to one run. A single-run cost is always admitted into an empty pool, whatever
 * the budget says: a box too small for one compiler still has to typecheck.
 */
function claimSlot(
  directory: string,
  slots: number,
  note: string,
  costMb: number,
  budgetMb: number,
): string | null {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const held = heldCostMb(directory, slots)
  if (held > 0 && held + costMb > budgetMb) return null
  for (let index = 0; index < slots; index += 1) {
    const path = join(directory, `slot-${index}`)
    if (writeSlot(path, note, costMb, true)) return path
    if (!slotIsStale(path)) continue
    // Racy by construction — another waiter may reclaim the same corpse first —
    // which is why the re-create is still exclusive and a loss just moves on.
    rmSync(path, { force: true })
    if (writeSlot(path, note, costMb, true)) return path
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
  const budgetMb = resolveValidationBudgetMb(env)
  const slots = resolveValidationSlots(env, undefined, budgetMb)
  const costMb = VALIDATION_COST_MB[validationClass]
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
      slot = claimSlot(directory, slots, note, costMb, budgetMb)
      if (slot) break
      if (!announced) {
        announced = true
        console.error(
          `validation queued: ${slots} slots, ${budgetMb}MB budget, this run needs ${costMb}MB ` +
            `(${VALIDATION_SLOTS_ENV}, ${VALIDATION_BUDGET_MB_ENV})`,
        )
      }
      await Bun.sleep(pollMs)
    }

    // Same cadence as the advisory leases: a run longer than the TTL keeps its
    // claim alive rather than being reclaimed out from under itself.
    const held = slot
    renewalTimer = setInterval(() => {
      if (slotIsOurs(held)) writeSlot(held, note, costMb, false)
    }, options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS)

    // A slot is ONE worker. The cost above is charged for a single-worker lane;
    // vitest's default here is two, and a run that forks more than it was
    // charged for is how the budget lies. A caller that set its own limit keeps
    // it — a dedicated host says `auto` and means it.
    const child = spawnProcess(command, {
      ...options,
      env: {
        ...env,
        [VALIDATION_HELD_ENV]: POOL_HELD,
        ...(validationClass === 'focused' && !env.PODIUM_TEST_WORKERS
          ? { PODIUM_TEST_WORKERS: '1' }
          : {}),
      },
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
  assertBunToolchain()
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
