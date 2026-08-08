/**
 * After-file leak guard for the reusable-runner shard [POD-527].
 *
 * The reused project runs many test files in one process, so the process-exit cleanup that
 * every other lane relies on no longer happens between them. This is the thing that makes
 * that safe to say out loud: it snapshots the process before a test file is imported and
 * compares after the file's last test, and it fails THAT file — by name, with the key that
 * moved — rather than letting the next file inherit the difference and fail somewhere
 * unrelated. A contamination bug that surfaces two files later, only in one order, is the
 * failure mode POD-515 refused to trade wall time for; this converts it into a local,
 * deterministic, self-naming failure.
 *
 * It is the runtime half of a pair. `apps/server/src/test-support/reuse-plan.ts` is the
 * static half: it reads each test file and demotes the ones whose *source* contains a
 * construct vitest does not undo between files. That scan cannot see a module-scoped cache
 * inside the source a test imports, or a handle a helper opened. This can — it observes the
 * process, not the text — but only after the fact. Neither is sufficient alone.
 *
 * Wired as the LAST setupFile of the reused project only, so it snapshots after the hermetic
 * env setup has minted this file's TMPDIR container and state root, and sees those as the
 * baseline rather than as drift.
 */
import { afterAll, expect, vi } from 'vitest'
import { releaseHermeticTmpContainer } from './test-hermetic-env'

/**
 * Globals whose *identity* is compared, on top of the key-set comparison below.
 *
 * A key-set diff catches `globalThis.somethingNew = …` but not `globalThis.fetch = vi.fn()`,
 * which is the far more common shape and leaves the key set identical. Rather than curate a
 * list of replaceable globals — the next one to matter would be the one not on it — compare
 * every own DATA property. Accessor properties are skipped: reading one runs its getter,
 * which is a side effect this guard has no business causing.
 */
function globalDataProperties(): Map<string, unknown> {
  const snapshot = new Map<string, unknown>()
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    if (descriptor && 'value' in descriptor) snapshot.set(key, descriptor.value)
  }
  return snapshot
}

/** Listener counts per process event — `process.on` inside a test file accumulates here. */
function processListenerCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of process.eventNames()) {
    counts.set(String(event), process.listenerCount(event))
  }
  return counts
}

/**
 * Open handles and requests, counted by kind.
 *
 * A test that starts a server and never closes it, or leaves an interval running, holds the
 * shared process open and keeps doing whatever it does while later files run. Under
 * isolation the fork's exit hid it; here it is a leak with a name.
 */
function activeResourceCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const kind of process.getActiveResourcesInfo()) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return counts
}

// The snapshot is only a baseline if the hermetic setup has already minted THIS file's state
// root and tmp container — otherwise the guard would read them as drift on every single file.
// It is the last entry in `setupFiles` and vitest imports them in order (`sequence.setupFiles`
// is not "parallel"), and the static import above forces `test-hermetic-env.ts` to evaluate
// first regardless. Both of those are someone else's config to change, so assert the outcome
// rather than trusting either: a reordering must fail loudly here, not quietly weaken the
// baseline.
if (!process.env.PODIUM_STATE_DIR || !process.env.TMPDIR) {
  throw new Error(
    '[reuse guard] snapshotted before test-hermetic-env.ts had run — the reuse guard must be ' +
      'the LAST setupFile, or its baseline is the world before the hermetic setup rather than ' +
      'after it.',
  )
}

const before = {
  env: { ...process.env },
  cwd: process.cwd(),
  globals: globalDataProperties(),
  listeners: processListenerCounts(),
  resources: activeResourceCounts(),
  fakeTimers: vi.isFakeTimers(),
}

const describeValue = (value: unknown): string => {
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') return `[${value.constructor?.name ?? 'Object'}]`
  return String(value)
}

function envDrift(after: NodeJS.ProcessEnv): string[] {
  const drift: string[] = []
  for (const key of new Set([...Object.keys(before.env), ...Object.keys(after)])) {
    const wasSet = key in before.env
    const isSet = key in after
    if (!wasSet && isSet) drift.push(`process.env.${key} was added (${describeValue(after[key])})`)
    else if (wasSet && !isSet) drift.push(`process.env.${key} was deleted`)
    else if (before.env[key] !== after[key]) {
      drift.push(
        `process.env.${key} changed from ${describeValue(before.env[key])} ` +
          `to ${describeValue(after[key])}`,
      )
    }
  }
  return drift
}

function globalDrift(after: Map<string, unknown>): string[] {
  const drift: string[] = []
  for (const [key, value] of after) {
    if (!before.globals.has(key)) drift.push(`globalThis.${key} was added`)
    else if (!Object.is(before.globals.get(key), value)) {
      drift.push(`globalThis.${key} was replaced (now ${describeValue(value)})`)
    }
  }
  for (const key of before.globals.keys()) {
    if (!after.has(key)) drift.push(`globalThis.${key} was deleted`)
  }
  return drift
}

function countDrift(
  label: string,
  wasCounts: Map<string, number>,
  nowCounts: Map<string, number>,
): string[] {
  const drift: string[] = []
  for (const key of new Set([...wasCounts.keys(), ...nowCounts.keys()])) {
    const was = wasCounts.get(key) ?? 0
    const now = nowCounts.get(key) ?? 0
    // Only growth is a leak. A file that removes a listener or closes a handle it inherited
    // is doing something questionable, but it is not holding the process open, and the
    // vitest runtime legitimately settles handles downward between files.
    if (now > was) drift.push(`${label} "${key}" grew from ${was} to ${now}`)
  }
  return drift
}

afterAll(() => {
  const drift = [
    ...envDrift(process.env),
    ...(process.cwd() === before.cwd
      ? []
      : [`process.cwd() changed from ${before.cwd} to ${process.cwd()}`]),
    ...globalDrift(globalDataProperties()),
    ...(vi.isFakeTimers() === before.fakeTimers
      ? []
      : ['fake timers were left installed (call vi.useRealTimers())']),
    ...countDrift('process listeners on', before.listeners, processListenerCounts()),
    ...countDrift('open handle', before.resources, activeResourceCounts()),
  ]

  // Release before asserting: the container must go whether or not the file leaked, or a
  // single red file also fills the host's tmp for the rest of the run.
  releaseHermeticTmpContainer()

  if (drift.length === 0) return
  const testPath = expect.getState().testPath ?? '<unknown test file>'
  throw new Error(
    `[reuse leak] ${testPath} left process state behind, and this shard shares its runner ` +
      `with other files.\n` +
      drift.map((line) => `  - ${line}`).join('\n') +
      `\n\nRestore it in an afterAll/afterEach, or let it keep its own fork: adding a ` +
      `disqualifying construct (see apps/server/src/test-support/reuse-plan.ts) moves the ` +
      `file to the isolated project automatically.`,
  )
})
