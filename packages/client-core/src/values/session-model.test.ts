import { describe, expect, it } from 'vitest'
import { effortControlHelp, modelControlHelp, modelReadoutHelp } from './session-model'

describe('thinking-time help', () => {
  it.each([
    ['auto', 'Auto lets the agent choose how much time to spend thinking.'],
    ['none', 'Uses no extra thinking time.'],
    ['off', 'Uses no extra thinking time.'],
    ['minimal', 'Uses very little thinking time for quicker replies.'],
    ['low', 'Uses less thinking time for quicker replies.'],
    ['medium', 'Uses a balance of thinking time and reply speed.'],
    ['high', 'Uses more thinking time for difficult tasks, which can take longer.'],
    ['xhigh', 'Uses extra thinking time for difficult tasks, which can take longer.'],
    ['max', 'Uses the most thinking time available, which can take longer.'],
    ['ultra', 'Uses extended thinking time for the hardest tasks, which can take longer.'],
    ['future', 'Uses the agent\'s "future" thinking setting.'],
  ])('explains %s and the next-message action', (value, meaning) => {
    expect(effortControlHelp(value, 'ready', true)).toBe(
      `${meaning} Choose a thinking level here for your next message.`,
    )
  })

  it.each([
    ['pending', 'Wait for your current change to finish'],
    ['fixed', 'Thinking time is fixed here; choose it in the new-task box'],
    ['pick-model', 'Choose a model here first'],
    ['unsupported', 'This model offers no thinking levels here; choose another model'],
  ] as const)('explains why %s has no choices and how to proceed', (state, action) => {
    expect(effortControlHelp('high', state)).toContain(action)
  })
})

describe('model help', () => {
  it('distinguishes automatic selection, new tasks, and the next reply', () => {
    expect(modelControlHelp('Auto', true)).toBe(
      'Auto lets the agent choose which model generates its replies. Choose a model here before starting the task.',
    )
    expect(modelControlHelp('Sonnet', false, 'ready', true)).toBe(
      "Sonnet generates the agent's replies. Choose a model here for your next message.",
    )
    expect(modelControlHelp('Sonnet', false, 'pending', true)).toContain(
      'Wait for your current change to finish',
    )
  })

  it('describes confirmed choices and where to pick a new fixed model', () => {
    expect(modelReadoutHelp({ observedModel: 'opus', observedEffort: 'high' }, 'no', 'Opus')).toBe(
      'Opus generates the replies, with more thinking time for difficult tasks, which can take longer. These choices are fixed here; choose them in the new-task box for a new session.',
    )
  })

  it('keeps each unconfirmed choice explicit, even when the other is confirmed', () => {
    expect(modelReadoutHelp({ model: 'opus', effort: 'high' }, 'no', 'Opus')).toContain(
      'Opus is selected for this session with more thinking time for difficult tasks, which can take longer (not yet confirmed).',
    )
    expect(
      modelReadoutHelp({ observedModel: 'opus', requestedEffort: 'low' }, 'no', 'Opus'),
    ).toContain(
      'Opus generates the replies, with less thinking time for quicker replies (selected, not yet confirmed).',
    )
    expect(modelReadoutHelp({ model: 'opus', observedEffort: 'low' }, 'no', 'Opus')).toContain(
      'Opus was selected for this session but is not yet confirmed, with less thinking time for quicker replies.',
    )
    expect(modelReadoutHelp({ requestedModel: 'opus' }, 'no', 'Opus')).toContain(
      'Opus is selected for your next reply but is not yet confirmed.',
    )
  })

  it('offers a real next step for a sleeping session or unavailable capability', () => {
    expect(modelReadoutHelp({ model: 'auto' }, 'yes', 'Auto')).toBe(
      'The agent chooses which model generates its replies. Wake this session to change its model or thinking time here.',
    )
    expect(modelReadoutHelp({}, 'unknown', undefined)).toContain(
      'Model changes are not available yet',
    )
  })
})
