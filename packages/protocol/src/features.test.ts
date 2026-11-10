import { describe, expect, it } from 'vitest'
import {
  FEATURES,
  type FeatureDefinition,
  type FeatureResolveInput,
  type FeatureState,
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
  it('registers every Labs surface with plain copy', () => {
    expect(FEATURES).toEqual(
      expect.arrayContaining([
        {
          id: 'draft-sync',
          name: 'Draft sync',
          description: 'Unsent prompts follow you between devices.',
          visibility: 'edge',
        },
        {
          id: 'runtime-drivers',
          name: 'Headless agents',
          description: 'Run some agents without a terminal.',
          visibility: 'stable',
        },
        {
          id: 'command-palette',
          name: 'Search everything (Cmd+K)',
          description: 'Takes effect after the server restarts.',
          visibility: 'edge',
        },
        {
          id: 'git-panel',
          name: 'Git panel',
          description: 'Branch and diff state beside each session.',
          visibility: 'edge',
        },
        {
          id: 'messages-panel',
          name: 'Messages panel',
          description: 'Agent-to-agent mail in the right dock.',
          visibility: 'edge',
        },
        {
          id: 'shipping',
          name: 'Shipping',
          description: 'Release trains for landed tasks.',
          visibility: 'edge',
        },
        {
          id: 'session-handoff',
          name: 'Session handoff',
          description: 'Move a running session to another agent.',
          visibility: 'edge',
        },
        {
          id: 'workflows',
          name: 'Workflows',
          description: 'Multi-step agent pipelines in their own mode.',
          visibility: 'edge',
        },
        {
          id: 'specs',
          name: 'Specs',
          description: 'Long-lived documents agents plan against.',
          visibility: 'edge',
        },
        {
          id: 'automations',
          name: 'Automations',
          description: 'Scheduled and triggered agent runs.',
          visibility: 'edge',
        },
        {
          id: 'podium-development',
          name: 'Podium development',
          description: 'Tools for people working on Podium itself.',
          visibility: 'stable',
        },
      ]),
    )
    for (const id of ['settings-search', 'shell-density', 'notifications'])
      expect(FEATURES.map((flag) => flag.id)).not.toContain(id)
    expect(FEATURES.map((flag) => flag.id)).not.toContain('mobx-sidebar')
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

describe('development visibility', () => {
  const def: FeatureDefinition = {
    id: 'f-development',
    name: 'Development',
    description: 'development',
    visibility: 'development',
  }

  it('lists the development audience with the feature off by default', () => {
    expect(
      resolveFeatureState(def, {
        channel: 'edge',
        devMode: false,
        developmentAudience: true,
      }),
    ).toEqual({ listed: true, enabled: false, source: 'default', locked: false })
  })

  it('does not list the feature for the edge audience alone', () => {
    expect(resolveFeatureState(def, { channel: 'edge', devMode: false, userValue: true })).toEqual({
      listed: false,
      enabled: false,
      source: 'default',
      locked: false,
    })
  })

  it('does not widen other hidden flags for the development audience', () => {
    expect(
      resolveFeatureState(defs.hidden, {
        channel: 'edge',
        devMode: false,
        developmentAudience: true,
      }).listed,
    ).toBe(false)
  })
})

/**
 * `command-palette` is the ONE switch for search [PDM-25] — the palette AND the
 * server's full-text index. These pin the three answers the server acts on at
 * boot, because "off" here means no fts5 tables and no transcript indexing.
 */
describe('command-palette resolves search', () => {
  const def = FEATURES.find((f) => f.id === 'command-palette')
  if (!def) throw new Error('command-palette must stay registered — the search gate reads it')

  it('is off by default, on every channel', () => {
    expect(resolveFeatureState(def, { channel: 'edge', devMode: false })).toEqual({
      listed: true,
      enabled: false,
      source: 'default',
      locked: false,
    })
    expect(resolveFeatureState(def, { channel: 'stable', devMode: false }).enabled).toBe(false)
  })

  it('a user toggle turns it on where the flag is listed', () => {
    expect(resolveFeatureState(def, { channel: 'edge', devMode: false, userValue: true })).toEqual({
      listed: true,
      enabled: true,
      source: 'user',
      locked: false,
    })
  })

  it('config wins and locks the toggle — how a hosted instance forces search off', () => {
    expect(
      resolveFeatureState(def, {
        channel: 'edge',
        devMode: false,
        configValue: false,
        userValue: true,
      }),
    ).toEqual({ listed: true, enabled: false, source: 'config', locked: true })
  })
})
