import { describe, expect, it } from 'vitest'
import {
  canConfigureModel,
  compactModelId,
  menuEffort,
  menuModel,
  readoutEffort,
  readoutModel,
} from './session-model'

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
