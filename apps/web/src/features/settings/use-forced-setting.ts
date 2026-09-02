import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'

/**
 * The keys that have an environment layer, mirrored from `LAYERED_KEYS` in
 * `@podium/runtime/config`. Restated rather than imported for the reason the
 * channel type in `sections/updates.tsx` is: the web bundle must never import
 * `@podium/runtime` (it pulls `node:fs`).
 */
export type ForcedSettingKey =
  | 'port'
  | 'hookPort'
  | 'agentRelayPort'
  | 'agentHome'
  | 'updateChannel'
  | 'updateFeed'
  | 'mode'
  | 'publicUrl'
  | 'appUrl'
  | 'allowedOrigins'
  | 'updateScope'
  | 'transcriptLake'

/**
 * A DISCRIMINATED UNION, so `env` is a string exactly where it is meaningful:
 * "forced but we cannot say by what" is not a state this hook can be in, and
 * spelling that in the type is what keeps the notice from needing an assertion
 * at every call site.
 */
export type ForcedSetting = { forced: false; env?: undefined } | { forced: true; env: string }

type Provenance = Partial<Record<ForcedSettingKey, { source: string; env?: string }>>

const NOT_FORCED: ForcedSetting = { forced: false }

/**
 * ONE read of `setup.provenance`, shared by every control that asks.
 *
 * Cached at module scope because provenance is a BOOT FACT: the environment
 * cannot change under a running server, so the answer is the same for the life
 * of the process, and N disabled controls must not mean N round-trips. The
 * cache is a promise rather than a value so concurrent first mounts share one
 * request.
 */
let pending: Promise<Provenance> | undefined

/**
 * NOTHING FORCED IS THE FAILURE MODE, deliberately.
 *
 * A server older than `setup.provenance` has no such procedure, and neither
 * does a test that stubs only the reads its own section makes. Both must leave
 * every control exactly as it was rather than disabling the page — "the
 * environment might be forcing this" is not a reason to take an affordance
 * away, so an absent or failed read answers "not forced" and says nothing.
 */
function loadProvenance(trpc: unknown): Promise<Provenance> {
  pending ??= (async (): Promise<Provenance> => {
    try {
      const provenance = (
        trpc as { setup?: { provenance?: { query?: () => Promise<Provenance> } } }
      ).setup?.provenance
      if (typeof provenance?.query !== 'function') return {}
      return await provenance.query()
    } catch {
      return {}
    }
  })()
  return pending
}

/** Test seam: drop the cached read so a case can serve its own provenance. */
export function resetForcedSettingCache(): void {
  pending = undefined
}

/**
 * IS THIS SETTING THE DEPLOYMENT'S RATHER THAN THE OPERATOR'S?
 *
 * The pattern this generalizes is the Updates section's `envForced` state, which
 * exists because a control that offers a write the environment overrides reads
 * as success and leaves the fleet somewhere else. That was true of one key; it
 * is now true of five more, and five more copies of a `Boolean(process.env.X)`
 * on the server paired with a `useState` here is five more chances for the two
 * to disagree.
 *
 * A forced control renders DISABLED with {@link forcedNotice} beside it. It
 * never hides the VALUE — the operator still needs to see what the deployment
 * chose — it removes only the affordance to change it.
 *
 * Returns `{ forced: false }` until the read resolves, so a control is never
 * disabled on a guess.
 */
export function useForcedSetting(key: ForcedSettingKey): ForcedSetting {
  const trpc = useStoreSelector((s) => s.trpc)
  const [forced, setForced] = useState<ForcedSetting>(NOT_FORCED)
  useEffect(() => {
    let alive = true
    void loadProvenance(trpc).then((provenance) => {
      if (!alive) return
      const entry = provenance[key]
      setForced(
        entry?.source === 'env' && entry.env ? { forced: true, env: entry.env } : NOT_FORCED,
      )
    })
    return () => {
      alive = false
    }
  }, [trpc, key])
  return forced
}

/** The one sentence a forced control shows. It always names the variable to
 *  unset, because "something overrode you" is not actionable. */
export function forcedNotice(env: string): string {
  return `${env} is set in this deployment's environment and overrides this setting.`
}
