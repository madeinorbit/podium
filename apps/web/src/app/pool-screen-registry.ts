import type { ClientRuntime } from '@podium/client-core/engine'
import type { MobxPool } from '@podium/client-graph'
import type { createRuntimeWorklistPool } from '@podium/client-graph/runtime-pool'

export type PoolScreenOptions = NonNullable<Parameters<typeof createRuntimeWorklistPool>[1]>
export interface PoolScreen {
  readonly id?: string
  initialize(ui: ClientRuntime['ui']): void
  enabled(): boolean
  options?(runtime: ClientRuntime): PoolScreenOptions
  /** Register read-side sources and optional diagnostics on the existing pool.
   * A late attachment must return its disposer; it is immediately released. */
  attach?(runtime: ClientRuntime, pool: MobxPool): Promise<(() => void) | void>
  /** Optional diagnostics preserve their existing failure isolation. */
  optional?: boolean
}

export function screenOptions(screens: readonly PoolScreen[], runtime: ClientRuntime): PoolScreenOptions {
  const options = screens.filter(screen => screen.enabled()).map(screen => screen.options?.(runtime) ?? {})
  const summaries: NonNullable<PoolScreenOptions['summaries']> = {}
  for (const option of options) for (const entity of Object.keys(option.summaries ?? {}) as (keyof typeof summaries)[]) {
    summaries[entity] = [...new Set([...(summaries[entity] ?? []), ...(option.summaries?.[entity] ?? [])])]
  }
  return { ...Object.assign({}, ...options), summaries }
}

/** Own every async attachment even if principal teardown wins the race. Errors
 * follow the provider's existing fatal path; there is no fallback derivation. */
export function attachPoolScreens(screens: readonly PoolScreen[], runtime: ClientRuntime, pool: MobxPool, onError: (error: Error) => void): () => void {
  let disposed = false
  const stops: (() => void)[] = []
  for (const screen of screens) {
    if (!screen.enabled() || !screen.attach) continue
    void screen.attach(runtime, pool).then(stop => {
      if (!stop) return
      if (disposed) stop()
      else stops.push(stop)
    }).catch(error => { if (!disposed && !screen.optional) onError(error instanceof Error ? error : new Error(String(error))) })
  }
  return () => {
    if (disposed) return
    disposed = true
    for (const stop of stops.reverse()) stop()
    stops.length = 0
  }
}
