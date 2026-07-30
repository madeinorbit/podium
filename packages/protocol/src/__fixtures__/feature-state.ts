/**
 * Golden fixtures for the FeatureState family (POD-360).
 *
 * FeatureState is the one family in the covered set that is NOT a zod schema —
 * it is a TypeScript interface plus a pure resolver ([spec:SP-f4b9]), so the
 * schema walker cannot reach it and it would otherwise have been the gap in
 * "every message family". Its wire shape is assembled by
 * `apps/server/src/features.ts` (`FeatureStateWire`) as the flag DEFINITION
 * fields spread with the RESOLVED state; that shape is reproduced here rather
 * than imported, because protocol is a leaf package and must not depend on the
 * server. If the two ever disagree, this fixture is what says so.
 *
 * The corpus is the full cross product of the resolver's inputs against the
 * whole FEATURES catalog: every flag × config override (unset/on/off) × user
 * toggle (unset/on/off) × channel × devMode. That is deliberate over-coverage —
 * `listed` is the field that decides whether an unreleased surface is visible,
 * and a characterization suite for it should have no gaps to argue about.
 */

import { FEATURES, type FeatureState, resolveFeatureState } from '../features'

export interface FeatureStateCase {
  /** The resolver input, flattened for a readable diff. */
  input: {
    id: string
    visibility: string
    configValue: boolean | 'unset'
    userValue: boolean | 'unset'
    channel: 'stable' | 'edge'
    devMode: boolean
  }
  /** The FeatureStateWire shape as it crosses the hop. */
  wire: FeatureState & {
    id: string
    name: string
    description: string
    visibility: string
  }
}

const TRISTATE = ['unset', true, false] as const

export const buildFeatureStateCases = (): FeatureStateCase[] => {
  const cases: FeatureStateCase[] = []
  for (const def of FEATURES) {
    for (const configValue of TRISTATE) {
      for (const userValue of TRISTATE) {
        for (const channel of ['stable', 'edge'] as const) {
          for (const devMode of [false, true]) {
            const state = resolveFeatureState(def, {
              configValue: configValue === 'unset' ? undefined : configValue,
              userValue: userValue === 'unset' ? undefined : userValue,
              channel,
              devMode,
            })
            cases.push({
              input: {
                id: def.id,
                visibility: def.visibility,
                configValue,
                userValue,
                channel,
                devMode,
              },
              wire: {
                id: def.id,
                name: def.name,
                description: def.description,
                visibility: def.visibility,
                ...state,
              },
            })
          }
        }
      }
    }
  }
  return cases
}

export interface FeatureStateGolden {
  family: string
  note: string
  cases: FeatureStateCase[]
}

export const buildFeatureStateGolden = (): FeatureStateGolden => ({
  family: 'feature-state',
  note:
    'Golden FeatureState fixtures (POD-360). Generated — regenerate with ' +
    '`bun run fixtures:wire:update`. Producer of the wire shape: apps/server/src/features.ts.',
  cases: buildFeatureStateCases(),
})
