import { describe, expect, it } from 'vitest'
import { canConfigureModel, modelToken } from './AgentPanel'

// The header's model token [POD-121]: observed model beats the spawn selection,
// a spawn-time `auto` shows literally until observed [POD-158], effort renders
// compacted after a middle dot (alone if no model is known yet).
describe('modelToken', () => {
  it('compacts an observed model id with effort', () => {
    expect(modelToken({ observedModel: 'claude-fable-5', effort: 'medium' })).toBe('fable 5 · med')
  })

  it('joins consecutive numeric parts as a dotted version', () => {
    expect(modelToken({ observedModel: 'claude-opus-4-8' })).toBe('opus 4.8')
    expect(modelToken({ observedModel: 'claude-haiku-4-5-20251001' })).toBe('haiku 4.5')
    expect(modelToken({ observedModel: 'claude-sonnet-5' })).toBe('sonnet 5')
  })

  it('resolves observed over the spawn selection', () => {
    expect(modelToken({ observedModel: 'claude-fable-5', model: 'opus' })).toBe('fable 5')
  })

  it('falls back to the spawn selection, showing auto literally', () => {
    expect(modelToken({ model: 'opus' })).toBe('opus')
    expect(modelToken({ model: 'auto' })).toBe('auto')
    expect(modelToken({ model: 'auto', effort: 'medium' })).toBe('auto · med')
    expect(modelToken({})).toBeNull()
  })

  it('renders effort alone before any model is known', () => {
    expect(modelToken({ effort: 'high' })).toBe('high')
    expect(modelToken({ effort: 'auto' })).toBeNull()
  })

  it('observation replaces a spawn-time auto', () => {
    expect(modelToken({ observedModel: 'claude-fable-5', model: 'auto' })).toBe('fable 5')
  })

  it('hides an auto effort and passes unknown efforts through', () => {
    expect(modelToken({ observedModel: 'claude-fable-5', effort: 'auto' })).toBe('fable 5')
    expect(modelToken({ observedModel: 'claude-fable-5', effort: 'ultra' })).toBe('fable 5 · ultra')
  })

  it('prefers the observed effort over the spawn request', () => {
    expect(
      modelToken({ observedModel: 'claude-fable-5', observedEffort: 'high', effort: 'medium' }),
    ).toBe('fable 5 · high')
    expect(modelToken({ observedModel: 'claude-fable-5', observedEffort: 'medium' })).toBe(
      'fable 5 · med',
    )
  })
})

/**
 * THE RUNTIME-REQUEST ARM (POD-3081).
 *
 * A sticky configure changes what the session was ASKED for without changing
 * what it was LAUNCHED as and without — yet — changing what is OBSERVED. These
 * pin the order those three are read in, which is the only thing that decides
 * whether the header shows a model two changes out of date during the window
 * between a change and the next turn.
 */
describe('the runtime-requested model', () => {
  it('shows the runtime request over the SPAWN selection', () => {
    expect(modelToken({ model: 'gpt-5-codex', requestedModel: 'claude-opus-4-8' })).toBe('opus 4.8')
  })

  it('still lets an OBSERVATION win, because the old model is what is answering', () => {
    /**
     * NOT AN OVERSIGHT. `configure` is `next-turn` on every headless driver, so
     * a session mid-turn genuinely IS still on the model it started that turn
     * with. Showing the new one here would be the change-looks-applied misreport
     * this whole axis exists to stop; the dotted-rule provenance is what carries
     * "and you asked for something else".
     */
    expect(
      modelToken({ observedModel: 'claude-fable-5', requestedModel: 'claude-opus-4-8' }),
    ).toBe('fable 5')
  })

  it('reads the requested effort the same way, so the two halves cannot disagree', () => {
    expect(modelToken({ requestedModel: 'claude-opus-4-8', requestedEffort: 'medium' })).toBe(
      'opus 4.8 · med',
    )
    // The runtime request beats the spawn effort for the same reason the model
    // does — and a driver that carried one field and dropped the other is
    // exactly the half-applied change this pairing exists to catch.
    expect(
      modelToken({ requestedModel: 'claude-opus-4-8', requestedEffort: 'medium', effort: 'high' }),
    ).toBe('opus 4.8 · med')
  })

  it('leaves an untouched session reading exactly as it did before', () => {
    // The arm is ADDITIVE: absent `requestedModel` must change nothing, or every
    // session that has never been reconfigured is a regression.
    expect(modelToken({ observedModel: 'claude-fable-5', model: 'opus' })).toBe('fable 5')
    expect(modelToken({ model: 'auto' })).toBe('auto')
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
    // This is the only shape that licenses hiding the control.
    expect(canConfigureModel({ configureFields: [] })).toBe('no')
  })

  it('says NO for grok, which reports a field but not THAT field', () => {
    /**
     * The case this whole wire path exists for. grok-acp is driverFamily
     * 'server' like opencode, and declares configure for permissionMode alone —
     * it sends no model on session/new or session/prompt. A picker gated on the
     * family is offered here and can only ever refuse.
     */
    expect(canConfigureModel({ configureFields: ['permissionMode'] })).toBe('no')
  })

  it('says UNKNOWN when nothing was reported, and does NOT say no', () => {
    // The rolling-upgrade rule. `toBe('no')` here would pass a naive
    // implementation and hide the control across the fleet.
    expect(canConfigureModel({})).toBe('unknown')
    expect(canConfigureModel({ configureFields: undefined })).toBe('unknown')
  })
})
