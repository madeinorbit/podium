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

/** The side-by-side dialog: single-select with per-option previews. It has NO
 *  Other row, so free text cannot be typed into it (POD-770). */
const ASK_USER_QUESTION_PREVIEW = {
  role: 'tool',
  toolName: 'AskUserQuestion',
  toolInputJson: JSON.stringify({
    questions: [
      {
        question: 'Which migration?',
        multiSelect: false,
        options: [
          { label: 'Expand', preview: 'ALTER TABLE …' },
          { label: 'Rebuild', preview: 'CREATE TABLE __new …' },
        ],
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

  it('a re-observed CLASSIFIER ask does NOT mint a second row or re-announce', async () => {
    // The at-least-once defence: a re-rendered scraped menu is one ask.
    const scraped = (): AgentRuntimeState =>
      state({
        phase: 'needs_user',
        stateSource: 'classifier',
        need: {
          kind: 'permission',
          ask: { toolName: 'Bash', detail: 'ls', canAlwaysAllow: false },
        },
      })
    const { svc, published } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: scraped() })
    await svc.onStateChanged({ sessionId: S, prev: scraped(), next: scraped() })
    expect(svc.listOpen()).toHaveLength(1)
    // A collapsed duplicate must not ping every surface again.
    expect(published).toHaveLength(1)
  })

  it('two sequential HOOK asks for the same tool stay two enumerable asks', async () => {
    // The other half of the rule, and the one a whole-payload fingerprint gets
    // wrong: a hook fires once per real ask, so a session running `Bash: ls`
    // twice is blocked twice. Merging them would answer the first and leave the
    // session stuck on a second nothing enumerates.
    const { svc } = harness()
    const first = permissionState()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: first })
    const answered = state({ phase: 'working' })
    await svc.onStateChanged({ sessionId: S, prev: first, next: answered })
    const second = { ...permissionState(), since: '2026-08-14T00:05:00.000Z' }
    await svc.onStateChanged({ sessionId: S, prev: answered, next: second })
    expect(svc.listOpen()).toHaveLength(1)
    // Two rows overall: the first superseded when the session moved on, the
    // second open — not one row reused.
    expect(svc.listForSession(S)).toHaveLength(2)
  })

  it('a re-observation of the SAME hook transition still collapses', async () => {
    // `since` is the transition instant, so a repeated observation of one
    // transition is one ask — the discriminator distinguishes asks, not frames.
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    await svc.onStateChanged({ sessionId: S, prev: permissionState(), next: permissionState() })
    expect(svc.listForSession(S)).toHaveLength(1)
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
    // SUPERSEDED, not expired — the session moved on to a different ask.
    expect(svc.get(first.id)).toMatchObject({ status: 'superseded' })
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
    // EXPIRED here: the process died and took the menu with it.
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

describe('InteractionService — the public ask() ingress', () => {
  it('preserves the caller\u2019s id — W3 mints ask:<transitionId> and must keep it', async () => {
    const { svc } = harness()
    const { row, inserted } = await svc.ask({
      interaction: {
        id: 'ask:transition-7',
        sessionId: S,
        kind: 'permission',
        payload: { v: 1, toolName: 'Bash', canAlwaysAllow: false },
        source: 'hook',
        answerable: 'keystroke-emulated',
      },
    })
    expect(inserted).toBe(true)
    expect(row.id).toBe('ask:transition-7')
    // That id is what the driver answers THROUGH later, so it has to survive.
    expect(svc.listOpen().map((i) => i.id)).toEqual(['ask:transition-7'])
  })

  it('honours a caller-supplied fingerprint rather than guessing one', async () => {
    const { svc } = harness()
    await svc.ask({
      interaction: {
        id: 'a',
        sessionId: S,
        kind: 'permission',
        payload: { v: 1, toolName: 'Bash', canAlwaysAllow: false },
        source: 'protocol',
        answerable: 'structured',
        fingerprint: 'provider-request-9',
      },
    })
    const second = await svc.ask({
      interaction: {
        id: 'b',
        sessionId: S,
        kind: 'permission',
        payload: { v: 1, toolName: 'Bash', canAlwaysAllow: false },
        source: 'protocol',
        answerable: 'structured',
        fingerprint: 'provider-request-9',
      },
    })
    expect(second.inserted).toBe(false)
    expect(second.row.id).toBe('a')
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
    const { svc, delivered } = harness({ transcript: [ASK_USER_QUESTION] })
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
    const id = svc.listOpen()[0]!.id
    expect(await answerAs(svc, id, 'Postgres')).toEqual({ ok: true })
    expect(await answerAs(svc, id, 'SQLite')).toEqual({ ok: false, reason: 'already-answered' })
    // The whole point: a second delivery on a keystroke-emulated ask types
    // digits at a menu that has already moved.
    expect(delivered).toEqual(['1'])
  })

  it('REFUSES to answer a permission prompt by keystroke, and leaves it open', async () => {
    // POD-707: the native menu's ordinals vary per ask, so a denial can approve,
    // and always-allow must never be pressed programmatically. The refusal is
    // typed and — load-bearing — the ask STAYS OPEN, because a row marked
    // answered would drop out of `listOpen` and hide a session that is still
    // sitting on the prompt.
    const { svc, delivered } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    const id = svc.listOpen()[0]!.id
    const outcome = await answerAs(svc, id, 'allow')
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toBe('not-yet-supported')
    expect(outcome.detail).toContain('POD-707')
    expect(delivered).toEqual([])
    expect(svc.listOpen().map((i) => i.id)).toEqual([id])
    expect(svc.get(id)).toMatchObject({ status: 'asked' })
  })

  it('REFUSES a structured answer — no protocol driver exists yet', async () => {
    const { svc, store, delivered } = harness()
    store.insert({
      id: 'ixn_structured',
      sessionId: S,
      kind: 'question',
      payload: {
        v: 1,
        questions: [{ question: 'Which?', multiSelect: false, previewLayout: false, options: [] }],
      },
      source: 'protocol',
      answerable: 'structured',
      fingerprint: 'fp-structured',
      askedAt: '2026-08-14T00:00:00.000Z',
    })
    const outcome = await svc.answer({
      id: 'ixn_structured',
      answer: { kind: 'question', selections: [{ optionIndices: [1] }] },
      answeredBy: 'human',
      principal: PRINCIPAL,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toBe('not-yet-supported')
    expect(delivered).toEqual([])
    // W5/W6 replace this seam; until then the ask stays open.
    expect(svc.get('ixn_structured')).toMatchObject({ status: 'asked' })
  })

  it('answering a SUPERSEDED ask reads as already-answered', async () => {
    // The common cause is a person answering at the terminal. "Expired" would
    // say the answer was too late for an ask nobody handled; "already answered"
    // says the true thing — somebody got there first.
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    const id = svc.listOpen()[0]!.id
    await svc.onStateChanged({
      sessionId: S,
      prev: permissionState(),
      next: state({ phase: 'working' }),
    })
    expect(svc.get(id)).toMatchObject({ status: 'superseded' })
    expect(await answerAs(svc, id, 'allow')).toEqual({ ok: false, reason: 'already-answered' })
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
    // A PREVIEW-LAYOUT question, which is the case that genuinely cannot take
    // free text: that dialog has no Other row (POD-770), so routing text
    // through one would select option 1 and throw the text away.
    const { svc, delivered } = harness({ transcript: [ASK_USER_QUESTION_PREVIEW] })
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
    const id = svc.listOpen()[0]!.id
    const outcome = await answerAs(svc, id, 'DuckDB')
    expect(outcome.ok).toBe(false)
    expect(delivered).toEqual([])
    // Still blocked, still enumerable — a refusal must not resolve the row.
    expect(svc.listOpen()).toHaveLength(1)
  })

  it('refuses a typed answer whose kind does not match the ask', async () => {
    const { svc } = harness({ transcript: [ASK_USER_QUESTION] })
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
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
    const { svc } = harness({
      delivery: () => ({ ok: false, message: 'session not running' }),
      transcript: [ASK_USER_QUESTION],
    })
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
    const id = svc.listOpen()[0]!.id
    const outcome = await answerAs(svc, id, 'Postgres')
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
      payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
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

describe('InteractionService — needs-human failure materialization (POD-2414)', () => {
  it('a NON-auth error phase now produces an answerable row', async () => {
    // Before POD-2414 only an auth-shaped error class minted anything, so a
    // session stopped on billing sat there with nothing on any list.
    const { svc } = harness()
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'errored', error: { class: 'billing_error', retryable: false } }),
    })
    const [row] = svc.listOpen()
    expect(row).toMatchObject({ kind: 'recovery', status: 'asked' })
    expect(row?.kind === 'recovery' && row.payload.offered).toEqual(['full-resume', 'abandon'])
  })

  it('an auth error phase still produces exactly the login row it always did', async () => {
    const { svc } = harness()
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'errored', error: { class: 'authentication', retryable: false } }),
    })
    expect(svc.listOpen()[0]).toMatchObject({
      kind: 'login',
      payload: { provider: 'authentication', reason: 'auth-expired' },
    })
  })

  it('a RETRYABLE error phase still mints nothing', async () => {
    const { svc } = harness()
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'errored', error: { class: 'overloaded', retryable: true } }),
    })
    expect(svc.listOpen()).toHaveLength(0)
  })

  it('a needs_user phase Podium could NOT classify is still an enumerable ask', async () => {
    // The unreadable-prompt gap: `needs_user` with no `need` is the one phase
    // that literally means "a person has to act", and it used to produce
    // nothing — and then supersede whatever was open.
    const { svc } = harness()
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'needs_user', stateSource: 'poll' }),
    })
    const [row] = svc.listOpen()
    expect(row).toMatchObject({ kind: 'question', status: 'asked' })
    expect(row?.kind === 'question' && row.payload.questions[0]?.options).toEqual([])
    expect(row?.kind === 'question' && row.payload.questions[0]?.question).toContain(
      'could not read',
    )
  })

  it('an unreadable prompt refuses a free-text answer and STAYS open', async () => {
    const { svc, delivered } = harness()
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'needs_user', stateSource: 'poll' }),
    })
    const id = svc.listOpen()[0]?.id ?? ''
    const outcome = await answerAs(svc, id, 'yes')
    expect(outcome.ok).toBe(false)
    expect(delivered).toEqual([])
    expect(svc.get(id)).toMatchObject({ status: 'asked' })
  })

  it('a needs-human TURN FAILURE opens a row, and the next turn closes it', async () => {
    const { svc } = harness()
    await svc.onTurnEvent({
      sessionId: S,
      at: '2026-08-14T00:00:00.000Z',
      provider: 'claude',
      ev: { ev: 'failed', turnEpoch: 1, reason: 'auth-expired', disposition: 'needs-human' },
    })
    expect(svc.listOpen()[0]).toMatchObject({ kind: 'login', source: 'protocol' })
    // A turn STARTING is proof the session is no longer waiting on a credential
    // — whoever refreshed it.
    await svc.onTurnEvent({
      sessionId: S,
      at: '2026-08-14T00:01:00.000Z',
      ev: { ev: 'started', turnEpoch: 2, origin: 'human' },
    })
    expect(svc.listOpen()).toHaveLength(0)
  })

  it('the same failure repeated while open is ONE blocked session, not three', async () => {
    const { svc, published } = harness()
    const fail = (at: string) =>
      svc.onTurnEvent({
        sessionId: S,
        at,
        ev: {
          ev: 'failed',
          turnEpoch: 1,
          reason: 'context-overflow',
          disposition: 'needs-human',
        },
      })
    await fail('2026-08-14T00:00:00.000Z')
    await fail('2026-08-14T00:00:10.000Z')
    await fail('2026-08-14T00:00:20.000Z')
    expect(svc.listOpen()).toHaveLength(1)
    expect(published).toHaveLength(1)
  })

  it('a turn boundary does NOT close a mid-turn permission ask', async () => {
    // `login`/`recovery` are what a turn boundary resolves. A permission ask IS
    // a turn in progress; closing it on a turn event would close it the instant
    // it was raised.
    const { svc } = harness()
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: permissionState() })
    await svc.onTurnEvent({
      sessionId: S,
      at: '2026-08-14T00:01:00.000Z',
      ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' },
    })
    expect(svc.listOpen()).toHaveLength(1)
  })

  it('a terminal state change does NOT supersede a PROTOCOL-sourced ask', async () => {
    // The state path owns what it synthesized and nothing else. A driver's own
    // ask being wiped by an unrelated observation is a session blocked on a
    // prompt whose row vanished underneath it.
    const { svc } = harness()
    await svc.ask({
      interaction: {
        id: 'ixn_driver',
        sessionId: S,
        kind: 'permission',
        payload: { v: 1, toolName: 'edit', canAlwaysAllow: false },
        source: 'protocol',
        answerable: 'structured',
      },
    })
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'working' }),
    })
    expect(svc.get('ixn_driver')).toMatchObject({ status: 'asked' })
  })

  it('a driver retiring its OWN ask closes the row', async () => {
    // The other half of the scoping rule: the state path no longer wipes a
    // protocol ask, so the driver's own resolution has to retire it — otherwise
    // a list whose promise is "these sessions are blocked" accumulates sessions
    // that are not.
    const { svc } = harness()
    await svc.ask({
      interaction: {
        id: 'ixn_driver',
        sessionId: S,
        kind: 'permission',
        payload: { v: 1, toolName: 'edit', canAlwaysAllow: false },
        source: 'protocol',
        answerable: 'structured',
      },
    })
    svc.onInteractionResolved({
      sessionId: S,
      // SUPERSEDED, not answered: the aggregate did not record the decision and
      // must not claim to know what it was.
      ev: { ev: 'answered', id: 'ixn_driver', answeredBy: 'human', at: '2026-08-14T00:01:00.000Z' },
    })
    expect(svc.get('ixn_driver')).toMatchObject({ status: 'superseded' })
    expect(svc.listOpen()).toHaveLength(0)
  })

  it('a resolution for another session’s row is ignored', async () => {
    const { svc } = harness()
    await svc.ask({
      interaction: {
        id: 'ixn_driver',
        sessionId: S,
        kind: 'permission',
        payload: { v: 1, toolName: 'edit', canAlwaysAllow: false },
        source: 'protocol',
        answerable: 'structured',
      },
    })
    svc.onInteractionResolved({
      sessionId: asSessionId('ses_other'),
      ev: { ev: 'expired', id: 'ixn_driver', at: '2026-08-14T00:01:00.000Z' },
    })
    expect(svc.get('ixn_driver')).toMatchObject({ status: 'asked' })
  })

  it('a session exit still closes EVERYTHING, whatever raised it', async () => {
    const { svc } = harness()
    await svc.ask({
      interaction: {
        id: 'ixn_driver',
        sessionId: S,
        kind: 'permission',
        payload: { v: 1, toolName: 'edit', canAlwaysAllow: false },
        source: 'protocol',
        answerable: 'structured',
      },
    })
    svc.onSessionExited(S)
    expect(svc.listOpen()).toHaveLength(0)
  })
})

describe('InteractionService — STARTING recovery (POD-2414)', () => {
  const recoveryRow = (reason: 'cache-miss' | 'context-overflow') => ({
    id: `ixn_${reason}`,
    sessionId: S,
    kind: 'recovery' as const,
    payload: { v: 1, reason, prompt: 'Resume?', offered: ['full-resume', 'abandon'] },
    source: 'hook' as const,
    answerable: 'keystroke-emulated' as const,
    fingerprint: `fp-${reason}`,
    askedAt: '2026-08-14T00:00:00.000Z',
  })

  it('a resume-time recovery auto-answers and delivers PROSE, not the enum token', async () => {
    const { svc, store, delivered } = harness()
    store.insert(recoveryRow('cache-miss'))
    await svc.answer({
      id: 'ixn_cache-miss',
      answer: { kind: 'recovery', choice: 'full-resume' },
      answeredBy: 'policy',
      principal: PRINCIPAL,
    })
    // `full-resume` used to be typed at the agent verbatim.
    expect(delivered).toEqual(['Continue where you left off.'])
  })

  it('an UNDELIVERABLE policy answer reopens the ask instead of swallowing it', async () => {
    // The deadlock POD-2414 closes: the default claimed the row, delivery
    // failed, and the row left `listOpen` and the feed — so a session stalled at
    // startup became a session stalled with nothing on any surface.
    const { svc, published } = harness({
      delivery: () => ({ ok: false, message: 'no session to resume' }),
    })
    await svc.ask({
      interaction: {
        ...recoveryRow('cache-miss'),
        kind: 'recovery',
        payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
      },
    })
    const row = svc.get('ixn_cache-miss')
    expect(row).toMatchObject({ status: 'asked', policyVerdict: 'escalated' })
    expect(svc.listOpen()).toHaveLength(1)
    // The surfaces saw it open, then answered, then open again — the last word
    // is what a replica keeps.
    expect(published.at(-1)).toMatchObject({ status: 'asked' })
  })

  it('a HUMAN answer whose delivery failed stays resolved and honest', async () => {
    // The other side of the same rule: claiming first is what stops two people
    // typing at one menu, and `unverified` is the honest record for a human.
    const { svc, store } = harness({
      delivery: () => ({ ok: false, message: 'no live menu' }),
    })
    store.insert(recoveryRow('cache-miss'))
    await svc.answer({
      id: 'ixn_cache-miss',
      answer: { kind: 'recovery', choice: 'full-resume' },
      answeredBy: 'human',
      principal: PRINCIPAL,
    })
    expect(svc.get('ixn_cache-miss')).toMatchObject({
      status: 'answered',
      answeredBy: 'human',
      deliveredVia: 'unverified',
    })
  })

  it('a FAILURE recovery is never auto-answered — that is the retry loop', async () => {
    const { svc, delivered } = harness()
    // Through the same ingress the failure gate uses, so the default table sees
    // it exactly as production does.
    await svc.onTurnEvent({
      sessionId: S,
      at: '2026-08-14T00:00:30.000Z',
      ev: {
        ev: 'failed',
        turnEpoch: 1,
        reason: 'context-overflow',
        disposition: 'needs-human',
      },
    })
    expect(delivered).toEqual([])
    expect(svc.listOpen()).toHaveLength(1)
    expect(svc.listOpen()[0]).toMatchObject({ kind: 'recovery', status: 'asked' })
  })
})

describe('InteractionsRepository', () => {
  const row = (id: string, fingerprint: string, sessionId: SessionId = S) => ({
    id,
    sessionId,
    kind: 'permission' as const,
    payload: { v: 1, toolName: 'Bash', canAlwaysAllow: false },
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
    store.close('a', 'expired', '2026-08-14T00:01:00.000Z')
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
    store.close('done', 'expired', '2026-08-14T00:00:30.000Z')
    expect(store.pruneResolvedBefore('2026-08-14T01:00:00.000Z')).toBe(1)
    // An ask nobody answered is the one thing this table must not forget.
    expect(store.listOpen()).toHaveLength(1)
  })
})
