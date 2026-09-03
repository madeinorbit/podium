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
  it('registers every experimental surface with user-facing copy', () => {
    expect(FEATURES).toEqual(
      expect.arrayContaining([
        {
          id: 'draft-sync',
          name: 'Draft sync',
          description:
            'Bidirectional draft sync between the chat box and the agent’s native composer: text typed in either place mirrors to the other. Experimental — off by default.',
          visibility: 'edge',
        },
        {
          id: 'runtime-drivers',
          name: 'Headless session drivers',
          description:
            'Offer available headless runtime drivers when starting a session. Interactive CLI sessions remain the default.',
          visibility: 'stable',
        },
        {
          id: 'shell-density',
          name: 'Shell density',
          description: 'Choose between balanced and compact shell styling in Appearance.',
          visibility: 'edge',
        },
        {
          id: 'command-palette',
          name: 'Cmd+K search',
          description:
            'Search and navigate Podium from the Cmd+K command palette. Also keeps the full-text index of conversation summaries and mirrored transcripts that search and the assistant’s search tools use. Takes effect at the next server start.',
          visibility: 'edge',
        },
        {
          id: 'git-panel',
          name: 'Git panel',
          description: 'Show the Git tab in the right sidebar.',
          visibility: 'edge',
        },
        {
          id: 'messages-panel',
          name: 'Messages panel',
          description: 'Show the Messages tab in the right sidebar.',
          visibility: 'edge',
        },
        {
          id: 'merge-queue',
          name: 'Queues',
          description: 'Show merge and heavy-test queues in the right sidebar.',
          visibility: 'edge',
        },
        {
          id: 'shipping',
          name: 'Shipping',
          description: 'Show durable delivery progress in the right sidebar.',
          visibility: 'edge',
        },
        {
          id: 'session-handoff',
          name: 'Session handoff',
          description: 'Move a live session to another Podium server.',
          visibility: 'edge',
        },
        {
          id: 'workflows',
          name: 'Workflows',
          description:
            'Show workflows and give agents workflow-aware instructions and CLI guidance.',
          visibility: 'edge',
        },
        {
          id: 'specs',
          name: 'Specs',
          description:
            'Show living specs and give agents spec-aware instructions and CLI guidance.',
          visibility: 'edge',
        },
        {
          id: 'automations',
          name: 'Automations',
          description: 'Show scheduled automations and notification triggers.',
          visibility: 'edge',
        },
        {
          id: 'notifications',
          name: 'Notifications',
          description: 'Enable web and external notifications and their settings.',
          visibility: 'edge',
        },
      ]),
    )
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
