import { describe, expect, it } from 'vitest'
import {
  type FeatureDefinition,
  type FeatureResolveInput,
  type FeatureState,
  FEATURES,
  resolveFeatureState,
} from './features'

const defs: Record<'hidden' | 'edge' | 'stable', FeatureDefinition> = {
  hidden: {
    id: 'f-hidden',
    name: 'Hidden',
    description: 'hidden',
    visibility: 'hidden',
  },
  edge: {
    id: 'f-edge',
    name: 'Edge',
    description: 'edge',
    visibility: 'edge',
  },
  stable: {
    id: 'f-stable',
    name: 'Stable',
    description: 'stable',
    visibility: 'stable',
  },
}

type Case = {
  name: string
  visibility: keyof typeof defs
  input: FeatureResolveInput
  expected: FeatureState
}

/**
 * Exhaustive matrix over visibility × env × channel × config × user.
 * listed rules are independent of enablement; enablement prefers config,
 * then listed user, then default off.
 */
const cases: Case[] = []

for (const visibility of ['hidden', 'edge', 'stable'] as const) {
  for (const devMode of [false, true] as const) {
    for (const channel of ['stable', 'edge'] as const) {
      const listed =
        devMode || visibility === 'stable' || (visibility === 'edge' && channel === 'edge')

      // config absent, user absent
      cases.push({
        name: `${visibility} dev=${devMode} ch=${channel} config=∅ user=∅`,
        visibility,
        input: { channel, devMode },
        expected: { listed, enabled: false, source: 'default', locked: false },
      })

      // user on/off with config absent
      for (const userValue of [true, false] as const) {
        cases.push({
          name: `${visibility} dev=${devMode} ch=${channel} config=∅ user=${userValue}`,
          visibility,
          input: { channel, devMode, userValue },
          expected: listed
            ? { listed, enabled: userValue, source: 'user', locked: false }
            : { listed, enabled: false, source: 'default', locked: false },
        })
      }

      // config on/off (wins over user)
      for (const configValue of [true, false] as const) {
        for (const userValue of [undefined, true, false] as const) {
          const userLabel = userValue === undefined ? '∅' : String(userValue)
          cases.push({
            name: `${visibility} dev=${devMode} ch=${channel} config=${configValue} user=${userLabel}`,
            visibility,
            input: {
              channel,
              devMode,
              configValue,
              ...(userValue === undefined ? {} : { userValue }),
            },
            expected: {
              listed,
              enabled: configValue,
              source: 'config',
              locked: true,
            },
          })
        }
      }
    }
  }
}

describe('FEATURES registry', () => {
  it('includes the sample-experiment hidden flag', () => {
    expect(FEATURES).toEqual([
      {
        id: 'sample-experiment',
        name: 'Sample experiment',
        description:
          'Demonstrates the experimental-features system. Does nothing; remove when the first real flag lands.',
        visibility: 'hidden',
      },
    ])
  })
})

describe('resolveFeatureState matrix', () => {
  it.each(cases)('$name', ({ visibility, input, expected }) => {
    expect(resolveFeatureState(defs[visibility], input)).toEqual(expected)
  })

  it('unlisted user toggle is ignored (edge on stable channel)', () => {
    expect(
      resolveFeatureState(defs.edge, {
        channel: 'stable',
        devMode: false,
        userValue: true,
      }),
    ).toEqual({ listed: false, enabled: false, source: 'default', locked: false })
  })

  it('config force-disables even when user is on and flag is listed', () => {
    expect(
      resolveFeatureState(defs.stable, {
        channel: 'stable',
        devMode: false,
        configValue: false,
        userValue: true,
      }),
    ).toEqual({ listed: true, enabled: false, source: 'config', locked: true })
  })
})
