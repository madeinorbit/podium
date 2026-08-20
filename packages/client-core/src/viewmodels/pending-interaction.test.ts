/**
 * THE BLOCKING-ASK CARD (POD-2414) — one decision table, two shells.
 *
 * These tests are the reason the viewmodel exists: the rules they pin are the
 * ones a React card and a React Native card would otherwise each answer for
 * themselves, and the wrong answer is a button that submits something the
 * server refuses or a session left with a card that only shrugs.
 */

import type { PendingInteractionWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { pendingInteractionCard, pendingInteractionCards } from './pending-interaction'

const base = {
  id: 'ixn_1',
  sessionId: 'ses_1',
  askedAt: '2026-08-20T00:00:00.000Z',
  source: 'hook',
  status: 'asked',
  fingerprint: 'fp',
} as const

const row = (extra: Record<string, unknown>): PendingInteractionWire =>
  ({ ...base, ...extra }) as unknown as PendingInteractionWire

describe('pendingInteractionCard', () => {
  it('offers NO button for a keystroke permission, and says why (POD-707)', () => {
    const card = pendingInteractionCard(
      row({
        kind: 'permission',
        answerable: 'keystroke-emulated',
        payload: { v: 1, toolName: 'Bash', inputSummary: 'rm -rf .', canAlwaysAllow: true },
      }),
    )
    expect(card.actions).toEqual([])
    expect(card.note).toContain('terminal')
    expect(card.detail).toBe('Bash: rm -rf .')
  })

  it('offers allow/deny for a STRUCTURED permission, and always-allow only when offered', () => {
    const withAlways = pendingInteractionCard(
      row({
        kind: 'permission',
        answerable: 'structured',
        payload: { v: 1, toolName: 'edit', canAlwaysAllow: true },
      }),
    )
    expect(withAlways.actions.map((a) => a.id)).toEqual(['allow', 'allow-always', 'deny'])
    const without = pendingInteractionCard(
      row({
        kind: 'permission',
        answerable: 'structured',
        payload: { v: 1, toolName: 'edit', canAlwaysAllow: false },
      }),
    )
    expect(without.actions.map((a) => a.id)).toEqual(['allow', 'deny'])
  })

  it('defers a readable KEYSTROKE question to the transcript card', () => {
    const card = pendingInteractionCard(
      row({
        kind: 'question',
        answerable: 'keystroke-emulated',
        payload: {
          v: 1,
          questions: [
            {
              question: 'Which database?',
              multiSelect: false,
              previewLayout: false,
              options: [{ label: 'Postgres' }, { label: 'SQLite' }],
            },
          ],
        },
      }),
    )
    expect(card.surface).toBe('transcript')
    expect(card.actions.map((a) => a.label)).toEqual(['Postgres', 'SQLite'])
    expect(card.actions[0]?.answer).toEqual({
      kind: 'question',
      selections: [{ optionIndices: [1] }],
    })
  })

  it('takes an UNREADABLE question itself, with no buttons and a reason', () => {
    // The prompt Podium could not classify — the whole point of materializing
    // it is that somebody sees it, and the honest action is "go look".
    const card = pendingInteractionCard(
      row({
        kind: 'question',
        answerable: 'keystroke-emulated',
        payload: {
          v: 1,
          questions: [
            { question: 'waiting', multiSelect: false, previewLayout: false, options: [] },
          ],
        },
      }),
    )
    expect(card.surface).toBe('aggregate')
    expect(card.actions).toEqual([])
    expect(card.note).toContain('could not read')
  })

  it('refuses to press a PREVIEW-LAYOUT question (POD-770)', () => {
    const card = pendingInteractionCard(
      row({
        kind: 'question',
        answerable: 'keystroke-emulated',
        payload: {
          v: 1,
          questions: [
            {
              question: 'Which layout?',
              multiSelect: false,
              previewLayout: true,
              options: [
                { label: 'A', preview: '…' },
                { label: 'B', preview: '…' },
              ],
            },
          ],
        },
      }),
    )
    expect(card.actions).toEqual([])
    expect(card.surface).toBe('aggregate')
  })

  it('keeps a STRUCTURED question on the aggregate — no transcript card exists for it', () => {
    // An opencode `question.asked` is a protocol interaction with no Claude
    // AskUserQuestion item behind it. Deferring hid the only answerable row a
    // server-family session has, on a session with no terminal to fall back to.
    const card = pendingInteractionCard(
      row({
        kind: 'question',
        answerable: 'structured',
        payload: {
          v: 1,
          questions: [
            {
              question: 'Which database?',
              multiSelect: false,
              previewLayout: false,
              options: [{ label: 'Postgres' }, { label: 'SQLite' }],
            },
          ],
        },
      }),
    )
    expect(card.surface).toBe('aggregate')
    expect(card.actions.map((a) => a.label)).toEqual(['Postgres', 'SQLite'])
  })

  it('a login ask asks for a REPORT, never a credential', () => {
    const card = pendingInteractionCard(
      row({
        kind: 'login',
        answerable: 'keystroke-emulated',
        payload: { v: 1, provider: 'anthropic', reason: 'auth-expired', url: 'https://x.test' },
      }),
    )
    expect(card.actions.map((a) => a.answer)).toEqual([
      { kind: 'login', outcome: 'completed' },
      { kind: 'login', outcome: 'cancelled' },
    ])
    expect(card.detail).toContain('https://x.test')
  })

  it('a recovery ask offers only what the answer path can perform', () => {
    // `fresh-session` means spawning a NEW session — a verb the answer command
    // does not perform. `abandon` had only one delivery route and it WOKE the
    // session it claimed to stop, so a button for either would report something
    // that did not happen (POD-2414 review).
    const card = pendingInteractionCard(
      row({
        kind: 'recovery',
        answerable: 'keystroke-emulated',
        payload: {
          v: 1,
          reason: 'context-overflow',
          prompt: 'The turn outgrew the window.',
          offered: ['full-resume', 'fresh-session', 'abandon'],
        },
      }),
    )
    expect(card.actions.map((a) => a.id)).toEqual(['full-resume'])
  })

  it('an elicitation offers only a decline, and says a form is needed', () => {
    const card = pendingInteractionCard(
      row({
        kind: 'elicitation',
        answerable: 'structured',
        payload: { v: 1, message: 'Pick a repo', requestedSchema: {}, serverName: 'github' },
      }),
    )
    expect(card.actions.map((a) => a.id)).toEqual(['decline'])
    expect(card.note).toContain('form')
    expect(card.detail).toBe('github: Pick a repo')
  })
})

describe('pendingInteractionCards', () => {
  it('keeps only this session’s OPEN asks, oldest first', () => {
    const cards = pendingInteractionCards(
      [
        row({
          id: 'b',
          kind: 'login',
          answerable: 'keystroke-emulated',
          askedAt: '2026-08-20T00:00:02.000Z',
          payload: { v: 1, provider: 'a', reason: 'auth-expired' },
        }),
        row({
          id: 'a',
          kind: 'login',
          answerable: 'keystroke-emulated',
          askedAt: '2026-08-20T00:00:01.000Z',
          payload: { v: 1, provider: 'a', reason: 'auth-expired' },
        }),
        row({
          id: 'other-session',
          sessionId: 'ses_2',
          kind: 'login',
          answerable: 'keystroke-emulated',
          payload: { v: 1, provider: 'a', reason: 'auth-expired' },
        }),
        row({
          id: 'resolved',
          status: 'answered',
          kind: 'login',
          answerable: 'keystroke-emulated',
          payload: { v: 1, provider: 'a', reason: 'auth-expired' },
        }),
      ],
      'ses_1',
    )
    expect(cards.map((c) => c.id)).toEqual(['a', 'b'])
  })
})
