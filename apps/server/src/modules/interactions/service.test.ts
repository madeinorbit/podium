/**
 * The aggregate's behaviour (POD-2020) — W2's acceptance criteria, as tests.
 *
 * A Claude session hitting a permission prompt or an AskUserQuestion produces a
 * durable row; answering drives the native menu through the EXISTING delivery
 * path; answering twice returns the typed error; a re-rendered classified menu
 * does not mint a second row.
 */

import { type AgentRuntimeState, asSessionId, type SessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { type InteractionRow, InteractionsRepository } from '../../store/interactions'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import type { InboxPrincipalReference } from '../sessions/inbox'
import type { AnswerDeliveryResult } from '../superagent/answer-delivery'
import { InteractionService } from './service'

/** A literal rather than the exported `SYSTEM_INBOX_PRINCIPAL`: importing that
 *  VALUE pulls `modules/sessions/inbox` — and `bun:sqlite` behind it — into the
 *  test graph. The service only ever passes this through to the delivery gate,
 *  so the shape is all the test needs. */
const PRINCIPAL: InboxPrincipalReference = {
  kind: 'system',
  attribution: { actor: { kind: 'system', job: 'interaction-test' }, onBehalfOf: null },
  principalRef: 'interaction-test',
  delegation: null,
}

const S = asSessionId('ses_1')

const state = (partial: Partial<AgentRuntimeState>): AgentRuntimeState => ({
  phase: 'idle',
  since: '2026-08-14T00:00:00.000Z',
  nativeSubagentCount: 0,
  ...partial,
})

const permissionState = (detail = 'ls'): AgentRuntimeState =>
  state({
    phase: 'needs_user',
    stateSource: 'hook',
    need: { kind: 'permission', ask: { toolName: 'Bash', detail, canAlwaysAllow: false } },
  })

const questionState = (): AgentRuntimeState =>
  state({ phase: 'needs_user', stateSource: 'classifier', need: { kind: 'question' } })

const ASK_USER_QUESTION = {
  role: 'tool',
  toolName: 'AskUserQuestion',
  toolInputJson: JSON.stringify({
    questions: [
      {
        question: 'Which database?',
        multiSelect: false,
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
      },
    ],
  }),
}

function harness(
  options: { delivery?: (answer: string) => AnswerDeliveryResult; transcript?: unknown[] } = {},
) {
  const db = openMigratedTestDatabase()
  const store = new InteractionsRepository(db)
  const published: InteractionRow[] = []
  const delivered: string[] = []
  let clock = 0
  const svc = new InteractionService({
    store,
    now: () => `2026-08-14T00:00:${String(clock++).padStart(2, '0')}.000Z`,
    publish: (row) => published.push(row),
    deliver: async (input) => {
      delivered.push(input.answer)
      return options.delivery?.(input.answer) ?? { ok: true, via: 'menu', choices: [] }
    },
    readTranscript: async () => ({
      items: (options.transcript ?? []) as never,
    }),
    policyPrincipal: () => PRINCIPAL,
  })
  return { svc, store, published, delivered }
}

const answerAs = (svc: InteractionService, id: string, text: string) =>
  svc.answer({ id, text, answeredBy: 'human', principal: PRINCIPAL })

describe('InteractionService — synthesis', () => {
  it('a permission prompt produces one durable, enumerable row', async () => {
    const { svc, published } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    const open = svc.listOpen()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      kind: 'permission',
      sessionId: S,
      source: 'hook',
      answerable: 'keystroke-emulated',
      status: 'asked',
      payload: { toolName: 'Bash', inputSummary: 'ls' },
    })
    expect(published).toHaveLength(1)
  })

  it('an AskUserQuestion menu carries its options onto the row', async () => {
    const { svc } = harness({ transcript: [ASK_USER_QUESTION] })
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
    const [row] = svc.listOpen()
    expect(row).toMatchObject({ kind: 'question', source: 'screen-classifier' })
    expect(row?.kind === 'question' && row.payload.questions[0]?.options).toEqual([
      { label: 'Postgres' },
      { label: 'SQLite' },
    ])
  })

  it('a re-observed ask does NOT mint a second row or re-announce', async () => {
    // The at-least-once defence: a re-rendered classified menu is one ask.
    const { svc, published } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    await svc.onStateChanged({ sessionId: S, prev: permissionState(), next: permissionState() })
    expect(svc.listOpen()).toHaveLength(1)
    // A collapsed duplicate must not ping every surface again.
    expect(published).toHaveLength(1)
  })

  it('a DIFFERENT ask on the same session expires the stale one', async () => {
    // Two open asks on one terminal session would both claim the same menu.
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState('ls') })
    const first = svc.listOpen()[0]!
    await svc.onStateChanged({
      sessionId: S,
      prev: permissionState('ls'),
      next: permissionState('rm -rf /'),
    })
    expect(svc.listOpen()).toHaveLength(1)
    expect(svc.get(first.id)).toMatchObject({ status: 'expired' })
  })

  it('leaving the asking state closes the open ask — whoever answered it', async () => {
    // Answered in the terminal by a human: the aggregate must stop claiming the
    // session is blocked, or it is lying about which sessions need attention.
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    await svc.onStateChanged({
      sessionId: S,
      prev: permissionState(),
      next: state({ phase: 'working' }),
    })
    expect(svc.listOpen()).toHaveLength(0)
  })

  it('a session exit expires everything it left behind', async () => {
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    svc.onSessionExited(S)
    expect(svc.listOpen()).toHaveLength(0)
    expect(svc.listForSession(S)[0]).toMatchObject({ status: 'expired' })
  })

  it('never throws into the bus when synthesis faults', async () => {
    const { svc } = harness()
    // A transcript read that rejects must not break the state-change fan-out
    // the badge and the inbox ride on.
    const broken = new InteractionService({
      store: new InteractionsRepository(openMigratedTestDatabase()),
      now: () => '2026-08-14T00:00:00.000Z',
      publish: () => {},
      deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
      readTranscript: async () => {
        throw new Error('daemon offline')
      },
      policyPrincipal: () => PRINCIPAL,
    })
    await expect(
      broken.onStateChanged({ sessionId: S, prev: undefined, next: questionState() }),
    ).resolves.toBeUndefined()
    void svc
  })
})

describe('InteractionService — answering', () => {
  it('drives the native menu through the existing delivery path', async () => {
    const { svc, delivered } = harness({ transcript: [ASK_USER_QUESTION] })
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
    const id = svc.listOpen()[0]!.id
    const outcome = await answerAs(svc, id, 'Postgres')
    expect(outcome).toEqual({ ok: true })
    // 1-based index, which is what the digit path types.
    expect(delivered).toEqual(['1'])
    expect(svc.get(id)).toMatchObject({
      status: 'answered',
      answeredBy: 'human',
      deliveredVia: 'menu',
      answer: { kind: 'question', selections: [{ optionIndices: [1] }] },
    })
  })

  it('answering twice returns the typed error and delivers once', async () => {
    const { svc, delivered } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    const id = svc.listOpen()[0]!.id
    expect(await answerAs(svc, id, 'allow')).toEqual({ ok: true })
    expect(await answerAs(svc, id, 'deny')).toEqual({ ok: false, reason: 'already-answered' })
    // The whole point: a second delivery on a keystroke-emulated ask types
    // digits at a menu that has already moved.
    expect(delivered).toEqual(['yes'])
  })

  it('answering an expired ask returns `expired`, not `already-answered`', async () => {
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    const id = svc.listOpen()[0]!.id
    svc.onSessionExited(S)
    expect(await answerAs(svc, id, 'allow')).toEqual({ ok: false, reason: 'expired' })
  })

  it('an unknown id is `unknown-interaction`', async () => {
    const { svc } = harness()
    expect(await answerAs(svc, 'ixn_nope', 'allow')).toEqual({
      ok: false,
      reason: 'unknown-interaction',
    })
  })

  it('an unresolvable answer refuses and leaves the ask OPEN', async () => {
    const { svc, delivered } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    const id = svc.listOpen()[0]!.id
    const outcome = await answerAs(svc, id, 'perhaps')
    expect(outcome.ok).toBe(false)
    expect(delivered).toEqual([])
    // Still blocked, still enumerable — a refusal must not resolve the row.
    expect(svc.listOpen()).toHaveLength(1)
  })

  it('refuses a typed answer whose kind does not match the ask', async () => {
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    const id = svc.listOpen()[0]!.id
    const outcome = await svc.answer({
      id,
      answer: { kind: 'recovery', choice: 'full-resume' },
      answeredBy: 'human',
      principal: PRINCIPAL,
    })
    expect(outcome.ok).toBe(false)
    expect(svc.listOpen()).toHaveLength(1)
  })

  it('records a failed delivery as answered-but-unverified rather than reopening', async () => {
    // The honest middle state: the row was claimed before delivery (so two
    // answers cannot both type), so a delivery failure leaves a claimed row.
    const { svc } = harness({ delivery: () => ({ ok: false, message: 'session not running' }) })
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    const id = svc.listOpen()[0]!.id
    const outcome = await answerAs(svc, id, 'allow')
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('session not running')
    expect(svc.get(id)).toMatchObject({ status: 'answered', deliveredVia: 'unverified' })
  })
})

describe('InteractionService — the default answer table', () => {
  it('auto-answers a recovery ask as policy, without a human', async () => {
    const { svc, store } = harness()
    store.insert({
      id: 'ixn_recovery',
      sessionId: S,
      kind: 'recovery',
      payload: { reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
      source: 'hook',
      answerable: 'keystroke-emulated',
      fingerprint: 'fp-recovery',
      askedAt: '2026-08-14T00:00:00.000Z',
    })
    const outcome = await svc.answer({
      id: 'ixn_recovery',
      answer: { kind: 'recovery', choice: 'full-resume' },
      answeredBy: 'policy',
      principal: PRINCIPAL,
    })
    expect(outcome).toEqual({ ok: true })
    expect(svc.get('ixn_recovery')).toMatchObject({
      status: 'answered',
      answeredBy: 'policy',
      answer: { choice: 'full-resume' },
    })
  })

  it('does NOT auto-answer a permission ask', async () => {
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    expect(svc.listOpen()[0]).toMatchObject({ status: 'asked' })
  })
})

describe('InteractionsRepository', () => {
  const row = (id: string, fingerprint: string, sessionId: SessionId = S) => ({
    id,
    sessionId,
    kind: 'permission' as const,
    payload: { toolName: 'Bash', canAlwaysAllow: false },
    source: 'hook' as const,
    answerable: 'keystroke-emulated' as const,
    fingerprint,
    askedAt: '2026-08-14T00:00:00.000Z',
  })

  it('collapses a duplicate open fingerprint and reports it as not inserted', () => {
    const store = new InteractionsRepository(openMigratedTestDatabase())
    expect(store.insert(row('a', 'fp')).inserted).toBe(true)
    const second = store.insert(row('b', 'fp'))
    expect(second.inserted).toBe(false)
    expect(second.row.id).toBe('a')
    expect(store.listOpen()).toHaveLength(1)
  })

  it('lets the SAME question be asked again once the first is resolved', () => {
    // A long session hits the same permission prompt repeatedly and each one
    // needs its own answer — which is why the unique index is partial.
    const store = new InteractionsRepository(openMigratedTestDatabase())
    store.insert(row('a', 'fp'))
    store.answer({
      id: 'a',
      answer: { kind: 'permission', decision: 'allow-once' },
      answeredBy: 'human',
      deliveredVia: 'menu',
      at: '2026-08-14T00:01:00.000Z',
    })
    expect(store.insert(row('b', 'fp')).inserted).toBe(true)
    expect(store.listOpen()).toHaveLength(1)
  })

  it('does not collapse the same fingerprint across sessions', () => {
    const store = new InteractionsRepository(openMigratedTestDatabase())
    store.insert(row('a', 'fp'))
    expect(store.insert(row('b', 'fp', asSessionId('ses_2'))).inserted).toBe(true)
  })

  it('recordDelivery lands on an ALREADY-ANSWERED row', () => {
    // Regression: the delivery outcome used to be written by a second
    // `answer()`, whose `WHERE status = 'asked'` guard — the idempotency claim —
    // matched nothing by then, so every successfully delivered answer stayed
    // recorded as `unverified`.
    const store = new InteractionsRepository(openMigratedTestDatabase())
    store.insert(row('a', 'fp'))
    store.answer({
      id: 'a',
      answer: { kind: 'permission', decision: 'allow-once' },
      answeredBy: 'human',
      deliveredVia: 'unverified',
      at: '2026-08-14T00:01:00.000Z',
    })
    expect(store.recordDelivery('a', 'menu')).toBe(true)
    expect(store.get('a')).toMatchObject({ deliveredVia: 'menu' })
  })

  it('recordDelivery does NOT resurrect an expired row', () => {
    const store = new InteractionsRepository(openMigratedTestDatabase())
    store.insert(row('a', 'fp'))
    store.expire('a', '2026-08-14T00:01:00.000Z')
    expect(store.recordDelivery('a', 'menu')).toBe(false)
  })

  it('answer() is the idempotency guarantee — the second conditional update loses', () => {
    const store = new InteractionsRepository(openMigratedTestDatabase())
    store.insert(row('a', 'fp'))
    const claim = () =>
      store.answer({
        id: 'a',
        answer: { kind: 'permission', decision: 'deny' },
        answeredBy: 'human',
        deliveredVia: 'menu',
        at: '2026-08-14T00:01:00.000Z',
      })
    expect(claim()).toBe(true)
    expect(claim()).toBe(false)
  })

  it('prunes resolved rows and NEVER open ones', () => {
    const store = new InteractionsRepository(openMigratedTestDatabase())
    store.insert(row('open', 'fp1'))
    store.insert(row('done', 'fp2'))
    store.expire('done', '2026-08-14T00:00:30.000Z')
    expect(store.pruneResolvedBefore('2026-08-14T01:00:00.000Z')).toBe(1)
    // An ask nobody answered is the one thing this table must not forget.
    expect(store.listOpen()).toHaveLength(1)
  })
})
