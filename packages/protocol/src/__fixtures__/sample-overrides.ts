/**
 * Per-schema sample overrides for the golden wire fixtures (POD-360).
 *
 * The walker in `sampler.ts` produces path-derived strings for free-form
 * `z.string()` fields. That is correct for branded ids (brands are
 * compile-time only) and for open vocabularies like preference paths. It is
 * NOT correct for closed vocabularies enforced by `.superRefine` /
 * `.refine` — the path string fails parse, and the fixture case records a
 * `parseError` instead of a wire pin.
 *
 * The walker checks this map by schema identity before walking a node, so a
 * refined field nested inside a larger object (e.g. `LayoutState.entityId`)
 * hits the same override as the schema when exported alone.
 *
 * Add an entry when a new schema cannot be satisfied by the generic walker.
 * Do not weaken the schema to make sampling easier — the override is the
 * intentional fixture value.
 */

import {
  LAYOUT_EXACT_KEYS,
  LayoutKeyField,
  LayoutSnapshot,
} from '@podium/model'
import type { z } from 'zod'
import type { SampleOptions } from './sampler'

/** One exact key from the closed layout vocabulary — stable fixture pin. */
const FIXTURE_LAYOUT_KEY = LAYOUT_EXACT_KEYS[0]

export type SampleOverride = (opts: SampleOptions, path: string) => unknown

/**
 * Schema identity → fixture value. Keys must be the same zod instances the
 * registry walks (exported singletons), not reconstructed clones.
 */
export const SAMPLE_OVERRIDES: ReadonlyMap<z.ZodTypeAny, SampleOverride> = new Map([
  // Closed isLayoutKey vocabulary (POD-1350 / POD-402). Path-derived samples
  // like "" / "entityId" / "key" fail the refine; pin the first exact key.
  [LayoutKeyField, () => FIXTURE_LAYOUT_KEY],
  // Record keys are plain z.string() with a whole-object refine, so the
  // LayoutKeyField override does not reach them — pin a valid map.
  [
    LayoutSnapshot,
    (opts) =>
      opts.mode === 'minimal'
        ? {}
        : { [FIXTURE_LAYOUT_KEY]: { unknownFixture: FIXTURE_LAYOUT_KEY } },
  ],
])
