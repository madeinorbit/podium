import { describe, expect, it } from 'vitest'
import {
  CONFIGURE_WRITE_FAILED,
  canConfigureModel,
  compactModelId,
  configureEndingNotice,
  effortControlHelp,
  menuEffort,
  menuModel,
  modelControlHelp,
  modelReadoutHelp,
  modelReadoutReason,
  readoutEffort,
  readoutModel,
} from './session-model'

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

// The readout's provenance order [POD-121, POD-158]: observed beats the runtime
// request beats the spawn selection, and a spawn-time `auto` shows literally
// until observed.
describe('readoutModel', () => {
  it('resolves observed over the spawn selection', () => {
    expect(readoutModel({ observedModel: 'claude-fable-5', model: 'opus' })).toBe('claude-fable-5')
    expect(readoutModel({ observedModel: 'claude-fable-5', model: 'auto' })).toBe('claude-fable-5')
  })

  it('falls back to the spawn selection, showing auto literally', () => {
    expect(readoutModel({ model: 'opus' })).toBe('opus')
    expect(readoutModel({ model: 'auto' })).toBe('auto')
    expect(readoutModel({})).toBeUndefined()
  })
})

/**
 * THE RUNTIME-REQUEST ARM (POD-3081).
 *
 * A sticky configure changes what the session was ASKED for without changing
 * what it was LAUNCHED as and without — yet — changing what is OBSERVED. These
 * pin the order those three are read in, which decides whether the readout shows
 * a model two changes out of date between a change and the next turn.
 */
describe('the runtime-requested model', () => {
  it('shows the runtime request over the SPAWN selection', () => {
    expect(readoutModel({ model: 'gpt-5-codex', requestedModel: 'claude-opus-4-8' })).toBe(
      'claude-opus-4-8',
    )
  })

  it('still lets an OBSERVATION win the readout, because the old model is what is answering', () => {
    // `configure` is `next-turn` on every headless driver, so a session mid-turn
    // genuinely IS still on the model it started that turn with.
    expect(
      readoutModel({ observedModel: 'claude-fable-5', requestedModel: 'claude-opus-4-8' }),
    ).toBe('claude-fable-5')
  })

  it('reads the requested effort the same way, so the two halves cannot disagree', () => {
    expect(readoutEffort({ requestedEffort: 'medium', effort: 'high' })).toBe('medium')
    expect(readoutEffort({ observedEffort: 'high', requestedEffort: 'medium' })).toBe('high')
  })

  it('shows no effort for a spawn-time auto', () => {
    expect(readoutEffort({ effort: 'auto' })).toBeUndefined()
    expect(readoutEffort({ effort: 'high' })).toBe('high')
  })
})

// A menu holds what the NEXT turn runs on: the request leads, so the menu the
// person just used answers with their pick (POD-6264).
describe('menuModel / menuEffort', () => {
  it('leads with the runtime request, then observation, then launch, then auto', () => {
    expect(menuModel({ observedModel: 'claude-fable-5', requestedModel: 'claude-opus-4-8' })).toBe(
      'claude-opus-4-8',
    )
    expect(menuModel({ observedModel: 'claude-fable-5', model: 'auto' })).toBe('claude-fable-5')
    expect(menuModel({ model: 'opus' })).toBe('opus')
    expect(menuModel({})).toBe('auto')
    expect(menuEffort({ observedEffort: 'high', requestedEffort: 'low' })).toBe('low')
    expect(menuEffort({})).toBe('auto')
  })
})

describe('compactModelId', () => {
  it('joins consecutive numeric parts as a dotted version and drops the date', () => {
    expect(compactModelId('claude-fable-5')).toBe('fable 5')
    expect(compactModelId('claude-opus-4-8')).toBe('opus 4.8')
    expect(compactModelId('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(compactModelId('gpt-6.1-sol')).toBe('gpt 6.1 sol')
  })
})

/**
 * WHETHER THE MODEL CONTROL MAY BE OFFERED (POD-3087).
 *
 * The three-valued answer is the point. A boolean would have to fold "we have
 * not been told" into one of the two real answers, and folding it into `false`
 * hides the control on every session in a fleet whose daemons are mid-upgrade —
 * silently, because a hidden control raises no error anywhere.
 */
describe('canConfigureModel', () => {
  it('says YES when the driver reported that it can change the model', () => {
    expect(canConfigureModel({ configureFields: ['model', 'effort'] })).toBe('yes')
  })

  it('says NO for a driver that reported an empty set', () => {
    // A TUI: the daemon DID answer, and the answer is that it changes nothing.
    expect(canConfigureModel({ configureFields: [] })).toBe('no')
  })

  it('says NO for grok, which reports a field but not THAT field', () => {
    // grok-acp is driverFamily 'server' like opencode, and declares configure
    // for permissionMode alone. A picker gated on the family can only refuse.
    expect(canConfigureModel({ configureFields: ['permissionMode'] })).toBe('no')
  })

  it('says UNKNOWN when nothing was reported, and does NOT say no', () => {
    expect(canConfigureModel({})).toBe('unknown')
    expect(canConfigureModel({ configureFields: undefined })).toBe('unknown')
  })
})

describe('chip sentences shared by web and phone (POD-2380)', () => {
  it('says how a configure change ended', () => {
    const ended = (status: string, result?: unknown, error?: { message?: string }) =>
      configureEndingNotice({ status, result, error })
    expect(ended('succeeded', { ok: true, effective: 'next-turn' })).toEqual({
      ok: true,
      text: 'The change applies from the next turn.',
    })
    expect(ended('succeeded', { ok: true, effective: 'now' })?.text).toBe(
      'The running session changed.',
    )
    expect(ended('failed', { reason: 'busy' })).toEqual({
      ok: false,
      text: 'Could not change the running session (busy).',
    })
    expect(ended('failed', { reason: 'busy', detail: 'Try later.' })?.text).toBe('Try later.')
    expect(ended('expired')?.text).toBe(
      'The change was not made in time; the session runs as before.',
    )
    expect(ended('failed', undefined, { message: 'Driver gone.' })?.text).toBe('Driver gone.')
    expect(ended('unknown')).toEqual({ ok: false, text: CONFIGURE_WRITE_FAILED })
    // A cancel is the person's own choice: nothing to say.
    expect(ended('cancelled')).toBeNull()
  })

  it('names the source of the shown model, then what stops a change', () => {
    expect(modelReadoutReason({ observedModel: 'opus' }, 'no')).toMatch(
      /^The model this agent is running, read from its transcript\. This harness takes its model/,
    )
    expect(modelReadoutReason({ requestedModel: 'opus' }, 'yes')).toMatch(
      /^Requested on the running session.*Wake it/,
    )
    expect(modelReadoutReason({}, 'unknown')).toMatch(/^Requested at launch.*has not reported/)
  })
})
