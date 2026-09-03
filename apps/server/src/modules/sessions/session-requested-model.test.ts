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

  it('is carried by the volatile capture/restore pair, which is NOT the reload path', () => {
    const session = makeSession()
    session.setRequestedModel({ model: 'gpt-5.1-codex-max', effort: 'medium' })

    const restored = makeSession()
    restored.restoreDurableState(session.captureDurableState())

    /**
     * WHAT THIS DOES AND DOES NOT PROVE — the title says the second half out
     * loud because an earlier version of it did not, and the reviewer was right
     * to call that out (POD-3081 review).
     *
     * `captureDurableState`/`restoreDurableState` is the VOLATILE-CAPTURE pair:
     * both halves run in one process over one object graph. It is a real path
     * and worth pinning — a field missing from it is dropped whenever the
     * repository slices volatile state — but it would keep passing with no
     * column, no migration, no SQL and no hydration behind it, which is exactly
     * the state it was passing over.
     *
     * The RELOAD claim lives in `session-requested-model-reload.test.ts`, which
     * goes through a migrated database and `sessionFromStoredRow`.
     */
    expect(restored.requestedModel).toBe('gpt-5.1-codex-max')
    expect(restored.requestedEffort).toBe('medium')
  })

  it('publishes both halves on the wire, so a client can render requested-vs-observed', () => {
    const session = makeSession()
    session.setRequestedModel({ model: 'gpt-5.1-codex-max' })
    session.setObservedModel('gpt-5-codex')

    const meta = session.toMeta(NO_SESSION_USER_STATE) as {
      requestedModel?: string
      observedModel?: string
    }

    // BOTH, DELIBERATELY. The UI's "requested, not yet observed" state is only
    // renderable when the two disagree AND both are readable — publishing the
    // winner of a precedence rule would collapse exactly the case worth showing.
    expect(meta.requestedModel).toBe('gpt-5.1-codex-max')
    expect(meta.observedModel).toBe('gpt-5-codex')
  })
})
