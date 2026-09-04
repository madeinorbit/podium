/**
 * THE SHARED HEADLESS INTERRUPT MARK (POD-3090).
 *
 * A stopped terminal turn leaves a mark in the conversation because Claude Code
 * writes one; a stopped HEADLESS turn left nothing, so reading the chat back,
 * an operator's own stop was indistinguishable from the model giving up
 * mid-sentence. These are the properties of the mapping every headless driver's
 * fence now goes through: it fires on a stop and only on a stop, whichever of
 * the two shapes the provider reports it in, and the identity it mints is stable
 * enough that a re-report, a re-adoption or a replay is still ONE stop.
 */

import { describe, expect, it } from 'vitest'
import {
  HEADLESS_INTERRUPT_TEXT,
  type HeadlessTurnResult,
  headlessInterruptItemId,
  headlessInterruptMark,
  isHeadlessInterruptResult,
} from './headless-interrupt.js'

const mark = (result: HeadlessTurnResult, overrides: { turnEpoch?: number } = {}) =>
  headlessInterruptMark({
    family: 'codex',
    sessionId: 'ses-1',
    turnEpoch: overrides.turnEpoch ?? 3,
    at: '2026-08-29T10:00:00.000Z',
    result,
  })

describe('the mark fires on a stop and only on a stop', () => {
  it('marks the completion verdict codex reports a stop as', () => {
    // Codex answers `turn/completed` with `status: 'interrupted'` — the stop is
    // a COMPLETION there, which is why a mapping keyed only on failures would
    // have missed the family that reports stops most cleanly.
    expect(mark({ kind: 'completed', verdict: 'interrupted' })).toMatchObject({
      role: 'user',
      text: HEADLESS_INTERRUPT_TEXT,
      event: 'interrupt',
      ts: '2026-08-29T10:00:00.000Z',
    })
  })

  it('marks the failure reason an opencode-style abort classifies as', () => {
    // opencode reports a cancelled turn as `session.error` carrying
    // `MessageAborted`, classified `interrupted`. Same stop, other shape.
    expect(mark({ kind: 'failed', reason: 'interrupted' })).toMatchObject({
      event: 'interrupt',
      text: HEADLESS_INTERRUPT_TEXT,
    })
  })

  it('marks nothing for a turn that ended by itself', () => {
    // The call site is unconditional, so every non-stop result has to answer
    // `undefined` here or a finished turn grows a stop rule it never earned.
    for (const verdict of ['done', 'question', 'approval', 'open_todos'] as const) {
      expect(mark({ kind: 'completed', verdict })).toBeUndefined()
    }
  })

  it('marks nothing for a turn that genuinely broke', () => {
    for (const reason of [
      'rate-limit',
      'auth-expired',
      'context-overflow',
      'provider-error',
      'timeout',
    ] as const) {
      expect(mark({ kind: 'failed', reason })).toBeUndefined()
    }
  })

  it('agrees with the predicate the drivers branch on', () => {
    expect(isHeadlessInterruptResult({ kind: 'completed', verdict: 'interrupted' })).toBe(true)
    expect(isHeadlessInterruptResult({ kind: 'failed', reason: 'interrupted' })).toBe(true)
    expect(isHeadlessInterruptResult({ kind: 'completed', verdict: 'done' })).toBe(false)
  })
})

describe('the identity that makes a replay one stop', () => {
  it('mints the same id for the same stop, however the provider reported it', () => {
    // The dedupe IS this equality: a duplicate terminal update, a session
    // re-adopted from its journal and a replayed event stream all produce the
    // same item, which every id-keyed consumer folds in place.
    const completed = mark({ kind: 'completed', verdict: 'interrupted' })
    const failed = mark({ kind: 'failed', reason: 'interrupted' })
    expect(completed?.id).toBe(failed?.id)
    expect(completed?.id).toBe(headlessInterruptItemId('codex', 'ses-1', 3))
  })

  it('separates a second stop from a re-report of the first', () => {
    // A retry is a new epoch, so the operator stopping twice reads as two stops
    // while one stop re-reported reads as one. A counter or a clock would have
    // collapsed these two cases into "always new".
    expect(mark({ kind: 'completed', verdict: 'interrupted' }, { turnEpoch: 4 })?.id).not.toBe(
      headlessInterruptItemId('codex', 'ses-1', 3),
    )
  })

  it('namespaces the id per family, so two drivers cannot collide', () => {
    expect(headlessInterruptItemId('opencode', 'ses-1', 3)).not.toBe(
      headlessInterruptItemId('codex', 'ses-1', 3),
    )
    // claude-sdk's record predates this mapping and its consumers key on the id
    // it already had; the mapping keeps it byte for byte.
    expect(headlessInterruptItemId('claude-sdk', 'ses-1', 3)).toBe('claude-sdk-interrupt-ses-1-3')
  })
})

describe('a family that says more than "stopped"', () => {
  it('keeps its own wording and role, and still renders as an interrupt', () => {
    // The claude-sdk driver knows whether the model host confirmed the stop, and
    // has always written that as a system note. What it lacked was the `event`
    // the chat's stop rule branches on.
    const item = headlessInterruptMark({
      family: 'claude-sdk',
      sessionId: 'ses-9',
      turnEpoch: 1,
      at: '2026-08-29T10:00:00.000Z',
      result: { kind: 'completed', verdict: 'interrupted' },
      role: 'system',
      text: 'Turn interrupted by the operator.',
    })
    expect(item).toMatchObject({
      id: 'claude-sdk-interrupt-ses-9-1',
      role: 'system',
      text: 'Turn interrupted by the operator.',
      event: 'interrupt',
    })
  })
})
