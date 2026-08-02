/**
 * A DENIED OUTBOX WRITE HAS TO REACH THE APP ON WEB (POD-1231).
 *
 * The side cache surfaces a refused queue write through `onDegraded` — and web
 * constructed it without one, so the report was built, logged and then dropped
 * at the seam while mobile's identical path reported it. ADR 6 D4.4 clause 3
 * requires the UI be explicitly informed, and a callback nobody passed is
 * indistinguishable from a callback that never fires.
 *
 * This drives the REAL composition root over a `localStorage` that denies the
 * outbox key the way a browser does at quota. The counterfactual is in the file:
 * the same write against a store that accepts it must report NOTHING, or the
 * case would pass against a root that reported unconditionally.
 */

import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
import { openKernelAssembly } from './kernelReplica'

const trpc = {
  sync: { feedChangesSince: { query: async () => ({ changes: [] }) } },
} as unknown as Parameters<typeof openKernelAssembly>[0]['trpc']

const entry = { mutationId: 'm1', kind: 'rename', input: {}, queuedAt: 1 }

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  globalThis.localStorage.clear()
})

/**
 * Deny writes to keys the predicate picks, leaving every other key working.
 *
 * Patched on the PROTOTYPE, not the instance: a DOM `Storage` is a proxy whose
 * property assignments become storage ENTRIES, so `localStorage.setItem = fn`
 * quietly stores a function under the key "setItem" and leaves the real method
 * in place — a double that never denies anything, which is the failure mode this
 * whole file exists to rule out.
 */
function denyLocalStorage(deny: (key: string) => boolean): void {
  // The whole object is REPLACED rather than patched. A DOM `Storage` is a proxy
  // that turns both property assignment and `defineProperty` into storage
  // entries, so every in-place patch of `setItem` leaves the real method running
  // — measured here, which is why the self-check below is not decoration.
  const real = globalThis.localStorage
  const fake: Record<string, unknown> = {}
  const define = (name: string, value: unknown) =>
    Object.defineProperty(fake, name, { value, enumerable: false, configurable: true })
  define('getItem', (k: string) => (Object.hasOwn(fake, k) ? (fake[k] as string) : null))
  define('setItem', (k: string, v: string) => {
    if (deny(k)) {
      const error = new Error('QuotaExceededError')
      error.name = 'QuotaExceededError'
      throw error
    }
    fake[k] = String(v)
  })
  define('removeItem', (k: string) => {
    delete fake[k]
  })
  define('clear', () => {
    for (const k of Object.keys(fake)) delete fake[k]
  })
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true })
  // The double must be able to say NO before anything is concluded from it —
  // and the swap must have actually taken, which two in-place patches did not.
  const probe = 'podium.probe.outbox'
  const check = expect(() => globalThis.localStorage.setItem(probe, 'x'))
  if (deny(probe)) check.toThrow(/QuotaExceeded/)
  else check.not.toThrow()
  globalThis.localStorage.removeItem(probe)
  restore = () => {
    Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true })
  }
}

async function open(databaseName: string) {
  const degraded: unknown[] = []
  const assembly = await openKernelAssembly({
    trpc,
    factory: new IDBFactory() as never,
    databaseName,
    evidence: { kind: 'single-account', principal: 'default' },
    principal: 'alice',
    onDegraded: (d) => degraded.push(d),
  })
  return { assembly, degraded }
}

describe('web reports an outbox write it could not persist', () => {
  it('surfaces the refusal to the app, naming the write that is not durable', async () => {
    // Installed BEFORE the assembly opens: the side cache captures the storage
    // object at construction, so a swap afterwards would leave the real one wired
    // and the case would pass for the wrong reason.
    denyLocalStorage((k) => k.includes('outbox') && !k.endsWith('.migrated'))
    const { assembly, degraded } = await open('outbox-degraded-1')

    const replica = assembly.createReplicaFn(assembly.principal)
    expect(() => replica.outboxStorage().save([entry])).toThrow()

    const failure = degraded.find(
      (d): d is { kind: string; notDurable: readonly string[] } =>
        (d as { kind?: unknown })?.kind === 'outbox-not-durable',
    )
    expect(failure).toBeDefined()
    expect(failure?.notDurable).toEqual(['m1'])
  })

  it('reports NOTHING when the same write is accepted — the counterfactual', async () => {
    denyLocalStorage(() => false)
    const { assembly, degraded } = await open('outbox-degraded-2')
    const replica = assembly.createReplicaFn(assembly.principal)
    expect(() => replica.outboxStorage().save([entry])).not.toThrow()
    expect(degraded.filter((d) => (d as { kind?: unknown })?.kind === 'outbox-not-durable')).toEqual(
      [],
    )
  })
})
