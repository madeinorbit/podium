/**
 * THREE FACTS ABOUT ONE SESSION'S MODEL, AND WHY THEY ARE THREE (POD-3081).
 *
 *   `model` / `effort`               — how it was LAUNCHED. Immutable.
 *   `requestedModel` / `requestedEffort` — what it was last ASKED for at runtime.
 *   `observedModel` / `observedEffort`   — what is actually ANSWERING.
 *
 * The temptation this suite exists to refuse is collapsing the first two: a
 * sticky configure "obviously" changes the session's model, and writing it onto
 * `model` would make every existing reader show the right thing for free. What
 * it destroys is the only durable answer to "what was this session started as",
 * and it destroys it silently the first time anyone changes their mind.
 */

import type { Geometry } from '@podium/model'
import { asMachineId, asSessionId, NO_SESSION_USER_STATE } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { Session } from './session'

const geo: Geometry = { cols: 80, rows: 24 }

const makeSession = () =>
  new Session({
    sessionId: asSessionId('s-configure'),
    durableLabel: 'podium-s-configure',
    agentKind: 'codex',
    cwd: '/w',
    title: 'w',
    origin: { kind: 'spawn' },
    createdAt: '2026-08-28T00:00:00.000Z',
    geometry: geo,
    machineId: asMachineId('machine-under-test'),
    model: 'gpt-5-codex',
    effort: 'high',
    toDaemon: vi.fn(),
  })

describe('setRequestedModel', () => {
  it('records the runtime request WITHOUT touching the launch record', () => {
    const session = makeSession()

    expect(session.setRequestedModel({ model: 'gpt-5.1-codex-max' })).toBe(true)

    expect(session.requestedModel).toBe('gpt-5.1-codex-max')
    // The launch pair is what "started as" means, and nothing about changing
    // your mind later makes it untrue.
    expect(session.model).toBe('gpt-5-codex')
    expect(session.effort).toBe('high')
  })

  it('is a PATCH: naming one field leaves the other where it was', () => {
    const session = makeSession()

    session.setRequestedModel({ model: 'gpt-5.1-codex-max' })
    session.setRequestedModel({ effort: 'medium' })

    /**
     * The control the operator did not touch is the one they will not think to
     * check. A replace-shaped write here would silently clear the model a moment
     * after it was set, and the only symptom would be worse work.
     */
    expect(session.requestedModel).toBe('gpt-5.1-codex-max')
    expect(session.requestedEffort).toBe('medium')
  })

  it('reports FALSE for a change that changes nothing, so a broadcast can be skipped', () => {
    const session = makeSession()
    expect(session.setRequestedModel({ model: 'gpt-5.1-codex-max' })).toBe(true)

    expect(session.setRequestedModel({ model: 'gpt-5.1-codex-max' })).toBe(false)
    expect(session.requestedModel).toBe('gpt-5.1-codex-max')
  })

  it('treats a blank value as naming nothing rather than as naming the empty string', () => {
    const session = makeSession()
    session.setRequestedModel({ model: 'gpt-5.1-codex-max' })

    expect(session.setRequestedModel({ model: '   ' })).toBe(false)
    // "No model chosen" and "the model is called nothing" are different states
    // and nothing downstream could tell them apart; the second must not exist.
    expect(session.requestedModel).toBe('gpt-5.1-codex-max')
  })

  it('survives the durable-state round trip a reload goes through', () => {
    const session = makeSession()
    session.setRequestedModel({ model: 'gpt-5.1-codex-max', effort: 'medium' })

    const restored = makeSession()
    restored.restoreDurableState(session.captureDurableState())

    /**
     * A CONFIGURE THAT EVAPORATES ON THE NEXT SERVER RESTART is the same
     * silent-reversion bug arriving through a new door: the driver's journal
     * still has the change, so the session goes on answering as the new model
     * while this side reports the launch one.
     */
    expect(restored.requestedModel).toBe('gpt-5.1-codex-max')
    expect(restored.requestedEffort).toBe('medium')
  })

  it('publishes both halves on the wire, so a client can render requested-vs-observed', () => {
    const session = makeSession()
    session.setRequestedModel({ model: 'gpt-5.1-codex-max' })
    session.setObservedModel('gpt-5-codex')

    const meta = session.toMeta(NO_SESSION_USER_STATE) as { requestedModel?: string; observedModel?: string }

    // BOTH, DELIBERATELY. The UI's "requested, not yet observed" state is only
    // renderable when the two disagree AND both are readable — publishing the
    // winner of a precedence rule would collapse exactly the case worth showing.
    expect(meta.requestedModel).toBe('gpt-5.1-codex-max')
    expect(meta.observedModel).toBe('gpt-5-codex')
  })
})
