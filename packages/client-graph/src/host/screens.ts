import type { ClientRuntime } from '@podium/client-core/engine'
import type { MobxPool } from '../pool'
import type { createRuntimeWorklistPool } from '../runtime-pool'

export type PoolScreenOptions = NonNullable<Parameters<typeof createRuntimeWorklistPool>[1]>
/** One screen's declaration in an app's screen list: what it needs from the
 * shared pool and how it plugs in. */
export interface PoolScreen {
  readonly id?: string
  /** Synchronous startup guard, before any lazy graph import. */
  prepare?(runtime: ClientRuntime): void | (() => void)
  options?(runtime: ClientRuntime): PoolScreenOptions
  /** Register read-side sources on the existing pool.
   * A late attachment must return its disposer; it is immediately released. */
  attach?(runtime: ClientRuntime, pool: MobxPool): Promise<(() => void) | void>
}

export function preparePoolScreens(
  screens: readonly PoolScreen[],
  runtime: ClientRuntime,
): () => void {
  const stops = screens.flatMap((screen) => {
    const stop = screen.prepare?.(runtime)
    return stop ? [stop] : []
  })
  return () => {
    for (const stop of stops.splice(0).reverse()) stop()
  }
}

export function screenOptions(
  screens: readonly PoolScreen[],
  runtime: ClientRuntime,
): PoolScreenOptions {
  const options = screens.map((screen) => screen.options?.(runtime) ?? {})
  const summaries: NonNullable<PoolScreenOptions['summaries']> = {}
  for (const option of options)
    for (const entity of Object.keys(option.summaries ?? {}) as (keyof typeof summaries)[]) {
      summaries[entity] = [
        ...new Set([...(summaries[entity] ?? []), ...(option.summaries?.[entity] ?? [])]),
      ]
    }
  const merged: PoolScreenOptions = Object.assign({}, ...options)
  if (Object.keys(summaries).length) merged.summaries = summaries
  else delete merged.summaries
  return merged
}

/** Own every async attachment even if principal teardown wins the race. Errors
 * follow the provider's existing fatal path; there is no fallback derivation. */
export function attachPoolScreens(
  screens: readonly PoolScreen[],
  runtime: ClientRuntime,
  pool: MobxPool,
  onError: (error: Error) => void,
): () => void {
  let disposed = false
  const stops: (() => void)[] = []
  for (const screen of screens) {
    if (!screen.attach) continue
    void screen
      .attach(runtime, pool)
      .then((stop) => {
        if (!stop) return
        if (disposed) stop()
        else stops.push(stop)
      })
      .catch((error) => {
        if (!disposed) onError(error instanceof Error ? error : new Error(String(error)))
      })
  }
  return () => {
    if (disposed) return
    disposed = true
    for (const stop of stops.reverse()) stop()
    stops.length = 0
  }
}
