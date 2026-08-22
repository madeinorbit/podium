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
  options: {
    delivery?: (answer: string) => AnswerDeliveryResult
    transcript?: unknown[]
    /** Wire a structured delivery route — the seam a protocol driver fills. */
    structured?: boolean
    /** Sessions the causal runtime-event stream owns failures for (P2/7). */
    causalSessions?: SessionId[]
  } = {},
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
    causalFailuresOwned: (sessionId) => (options.causalSessions ?? []).includes(sessionId),
    ...(options.structured ? { deliverStructured: async () => ({ ok: true as const }) } : {}),
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
    await svc.onSessionExited(S)
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
    await svc.onSessionExited(S)
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

  it('a REFUSED delivery reopens the ask and says so', async () => {
    // REVERSED IN THE THIRD PASS, and the old expectation is worth stating: this
    // asserted `outcome.ok === true` with an apologetic detail, and left the row
    // resolved. Both halves were wrong for a REFUSAL. Every `ok: false` out of
    // the delivery gate is a pre-send guard — no live session, no pending
    // question, nothing matched — so nothing was typed, the session is still
    // sitting at the menu, and a card that disappears there is the exact lie
    // this issue exists to prevent.
    const { svc } = harness({
      delivery: () => ({ ok: false, message: 'session not running' }),
      transcript: [ASK_USER_QUESTION],
    })
    await svc.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
    const id = svc.listOpen()[0]!.id
    const outcome = await answerAs(svc, id, 'Postgres')
    expect(outcome).toMatchObject({ ok: false, reason: 'delivery-failed' })
    expect(outcome.detail).toContain('session not running')
    // Still answerable, because nobody has answered it yet.
    expect(svc.get(id)).toMatchObject({ status: 'asked' })
    expect(svc.listOpen(S)).toHaveLength(1)
  })
})

describe('InteractionService — the default answer table', () => {
  it('auto-answers a recovery ask as policy, without a human', async () => {
    // STRUCTURED, since POD-2414's review round: a resume-time recovery is
    // answered by replying to the driver holding the handle in STARTING, and
    // the keystroke form of the same ask now refuses rather than prose-resuming
    // it. The policy behaviour under test — one entry, applied at ask time,
    // recorded as `policy` — is unchanged.
    const { svc, store } = harness({ structured: true })
    store.insert({
      id: 'ixn_recovery',
      sessionId: S,
      kind: 'recovery',
      payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
      source: 'protocol',
      answerable: 'structured',
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
    // Only what the answer path can perform — `abandon` was removed in the
    // review round because its one delivery route woke the session it claimed
    // to stop.
    expect(row?.kind === 'recovery' && row.payload.offered).toEqual(['full-resume'])
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
    await svc.onInteractionResolved({
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
    await svc.onInteractionResolved({
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
    await svc.onSessionExited(S)
    expect(svc.listOpen()).toHaveLength(0)
  })
})

describe('InteractionService — the POD-2414 adversarial review round', () => {
  it('a FAILED transcript read still leaves an enumerable blocked session', async () => {
    // P0/1. The read is an enrichment; letting it throw took the whole
    // synthesis down and stranded a live native menu with no row at all.
    const db = openMigratedTestDatabase()
    const store = new InteractionsRepository(db)
    let clock = 0
    const service = new InteractionService({
      store,
      now: () => `2026-08-14T00:00:${String(clock++).padStart(2, '0')}.000Z`,
      publish: () => {},
      deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
      readTranscript: async () => {
        throw new Error('transcript rpc is down')
      },
      policyPrincipal: () => PRINCIPAL,
    })
    await service.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
    const open = service.listOpen()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ kind: 'question', status: 'asked' })
  })

  it('refuses a RESUME-TIME recovery by keystroke instead of prose-resuming it', async () => {
    // P0/2. `cache-miss` is asked while the handle is held in STARTING;
    // answering it means resolving that prompt, and prose over the durable send
    // path only queues a turn behind it.
    const { svc, store, delivered } = harness()
    store.insert({
      id: 'ixn_resume',
      sessionId: S,
      kind: 'recovery',
      payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
      source: 'hook',
      answerable: 'keystroke-emulated',
      fingerprint: 'fp-resume',
      askedAt: '2026-08-14T00:00:00.000Z',
    })
    const outcome = await svc.answer({
      id: 'ixn_resume',
      answer: { kind: 'recovery', choice: 'full-resume' },
      answeredBy: 'human',
      principal: PRINCIPAL,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toBe('not-yet-supported')
    expect(delivered).toEqual([])
    expect(svc.get('ixn_resume')).toMatchObject({ status: 'asked' })
  })

  it('a FAILURE recovery is still answerable — it is not holding a handle open', async () => {
    const { svc, delivered } = harness()
    await svc.onTurnEvent({
      sessionId: S,
      at: '2026-08-14T00:00:00.000Z',
      ev: { ev: 'failed', turnEpoch: 1, reason: 'context-overflow', disposition: 'needs-human' },
    })
    const id = svc.listOpen()[0]?.id ?? ''
    const outcome = await svc.answer({
      id,
      answer: { kind: 'recovery', choice: 'full-resume' },
      answeredBy: 'human',
      principal: PRINCIPAL,
    })
    expect(outcome.ok).toBe(true)
    expect(delivered).toEqual(['Continue where you left off.'])
  })

  it('a PROVEN structured refusal reopens the ask instead of dropping it', async () => {
    // P1/4. The driver said it did not apply the answer, so its request is
    // still open — leaving the row resolved hides a session that is blocked.
    const db = openMigratedTestDatabase()
    const store = new InteractionsRepository(db)
    let clock = 0
    const published: InteractionRow[] = []
    const service = new InteractionService({
      store,
      now: () => `2026-08-14T00:00:${String(clock++).padStart(2, '0')}.000Z`,
      publish: (row) => published.push(row),
      deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
      readTranscript: async () => ({ items: [] }),
      policyPrincipal: () => PRINCIPAL,
      deliverStructured: async () => ({ ok: false, reason: 'not-yet-supported' }),
    })
    await service.ask({
      interaction: {
        id: 'ixn_structured_refused',
        sessionId: S,
        kind: 'permission',
        payload: { v: 1, toolName: 'edit', canAlwaysAllow: false },
        source: 'protocol',
        answerable: 'structured',
      },
    })
    const outcome = await service.answer({
      id: 'ixn_structured_refused',
      answer: { kind: 'permission', decision: 'allow-once' },
      answeredBy: 'human',
      principal: PRINCIPAL,
    })
    expect(outcome.ok).toBe(false)
    // The DRIVER'S OWN reason, not one word for every refusal (POD-2414
    // re-verdict, P0/1): a surface renders a permanent limitation differently
    // from a lost reply, and only one of the two is worth retrying.
    expect(outcome.ok === false && outcome.reason).toBe('not-yet-supported')
    expect(service.get('ixn_structured_refused')).toMatchObject({ status: 'asked' })
    expect(published.at(-1)).toMatchObject({ status: 'asked' })
  })

  it('a slow question read cannot strand a card on a session that moved on', async () => {
    // THE INTERLEAVING, DRIVEN (POD-2414 re-verdict, P1/5). Synthesizing a
    // question awaits the transcript, and the bus that calls this discards the
    // promise — so a `working` state used to overtake the read, find no row to
    // close because none was inserted yet, and let the stale question land
    // behind it. The card then said "blocked" about a session that was running.
    const db = openMigratedTestDatabase()
    const store = new InteractionsRepository(db)
    const published: InteractionRow[] = []
    let releaseRead: () => void = () => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let clock = 0
    const svc = new InteractionService({
      store,
      now: () => `2026-08-14T00:00:${String(clock++).padStart(2, '0')}.000Z`,
      publish: (row) => published.push(row),
      deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
      readTranscript: async () => {
        await readGate
        return { items: [] as never }
      },
      policyPrincipal: () => PRINCIPAL,
    })

    // A: a question arrives and blocks inside its transcript read.
    const asking = svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: { phase: 'needs_user', need: { kind: 'question' } } as never,
    })
    // B: the session moves on WHILE that read is outstanding.
    const working = svc.onStateChanged({
      sessionId: S,
      prev: { phase: 'needs_user', need: { kind: 'question' } } as never,
      next: { phase: 'working' } as never,
    })
    releaseRead()
    await Promise.all([asking, working])

    // Whatever order the bus handed them over, the session is not left claiming
    // to be blocked: B is applied after A, so it closes what A inserted.
    expect(svc.listOpen(S)).toEqual([])
  })

  it('a session that EXITS during a slow read is not left holding an ask', async () => {
    // THE SAME INTERLEAVING BETWEEN DIFFERENT HANDLERS (POD-2414 third pass).
    // Chaining `onStateChanged` alone only serialized that handler against
    // itself. `onSessionExited` was unchained, so it swept an open list that was
    // still empty and the transcript read then inserted an ask for a process
    // that no longer exists — a card offering to answer a dead session.
    const db = openMigratedTestDatabase()
    const store = new InteractionsRepository(db)
    let releaseRead: () => void = () => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let clock = 0
    const svc = new InteractionService({
      store,
      now: () => `2026-08-14T00:00:${String(clock++).padStart(2, '0')}.000Z`,
      publish: () => {},
      deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
      readTranscript: async () => {
        await readGate
        return { items: [] as never }
      },
      policyPrincipal: () => PRINCIPAL,
    })

    // A: a question arrives and blocks inside its transcript read.
    const asking = svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: { phase: 'needs_user', need: { kind: 'question' } } as never,
    })
    // B: the process dies WHILE that read is outstanding.
    const exited = svc.onSessionExited(S)
    releaseRead()
    await Promise.all([asking, exited])

    // The ask A inserted is expired by B behind it, rather than surviving it.
    expect(svc.listOpen(S)).toEqual([])
  })

  it("a TURN FAILURE cannot overtake a slow question synthesis", async () => {
    // THE SAME INTERLEAVING FOR THE TURN INGRESS (POD-2414 fourth pass). A
    // question state owns a slow transcript read; a causal failure arriving
    // behind it must not publish its login ask first. The per-session chain is
    // the ordering guarantee, not an incidental choice of which promise wins.
    const db = openMigratedTestDatabase()
    const store = new InteractionsRepository(db)
    const published: InteractionRow[] = []
    let releaseRead: () => void = () => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let startRead: () => void = () => {}
    const readStarted = new Promise<void>((resolve) => {
      startRead = resolve
    })
    const svc = new InteractionService({
      store,
      now: () => "2026-08-14T00:00:00.000Z",
      publish: (row) => published.push(row),
      deliver: async () => ({ ok: true, via: "menu", choices: [] }),
      readTranscript: async () => {
        startRead()
        await readGate
        return { items: [] as never }
      },
      policyPrincipal: () => PRINCIPAL,
    })

    // A: a question arrives and blocks inside its transcript read.
    const asking = svc.onStateChanged({ sessionId: S, prev: undefined, next: questionState() })
    await readStarted

    // B: a causal failure arrives WHILE A read is outstanding.
    const failed = svc.onTurnEvent({
      sessionId: S,
      at: "2026-08-14T00:00:30.000Z",
      provider: "claude",
      ev: { ev: "failed", turnEpoch: 1, reason: "auth-expired", disposition: "needs-human" },
    })
    releaseRead()
    await Promise.all([asking, failed])

    // A is the first ingress, so its question is announced before B failure.
    // Calling applyTurnEvent directly makes this assertion reverse.
    expect(published.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "question", status: "asked" },
      { kind: "login", status: "asked" },
    ])
  })

  it('a policy answer overtaken by a turn boundary does NOT reopen', async () => {
    // P1/5. The row is `answered` while delivery is in flight, so no closer can
    // supersede it; without the in-flight guard the reopen put a blocked card
    // back on a session that had demonstrably moved on.
    const db = openMigratedTestDatabase()
    const store = new InteractionsRepository(db)
    let clock = 0
    let service!: InteractionService
    service = new InteractionService({
      store,
      now: () => `2026-08-14T00:00:${String(clock++).padStart(2, '0')}.000Z`,
      publish: () => {},
      deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
      readTranscript: async () => ({ items: [] }),
      policyPrincipal: () => PRINCIPAL,
      // The turn boundary lands WHILE this delivery is in flight, and the
      // round-trip then THROWS — an unproven failure, which is the one that
      // reaches the policy reopen. (A typed refusal is proven and reopens on
      // its own path; that is the test above.)
      deliverStructured: async () => {
        await service.onTurnEvent({
          sessionId: S,
          at: '2026-08-14T00:00:30.000Z',
          ev: { ev: 'started', turnEpoch: 2, origin: 'human' },
        })
        throw new Error('the reply never came back')
      },
    })
    await service.ask({
      interaction: {
        id: 'ixn_overtaken',
        sessionId: S,
        kind: 'recovery',
        payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
        source: 'hook',
        answerable: 'structured',
      },
    })
    expect(service.get('ixn_overtaken')).toMatchObject({ status: 'answered' })
    expect(service.listOpen()).toHaveLength(0)
  })

  it('a session with a CAUSAL stream does not mint from the errored shadow', async () => {
    // REPLACES the arrival-order mechanism (POD-2414 re-verdict, P2/7). A driver
    // reports `turn/failed` with a real disposition and then the SAME failure
    // reappears as `errored` with only a boolean. The old fix remembered "a
    // fatal arrived" in memory, which assumed the causal event was projected
    // first — the board projector is one async global drain, so it may not be —
    // and lost the answer on restart. Provenance does not depend on either:
    // this session HAS a causal stream, so that stream owns its failures.
    const { svc } = harness({ causalSessions: [S] })
    await svc.onTurnEvent({
      sessionId: S,
      at: '2026-08-14T00:00:00.000Z',
      ev: { ev: 'failed', turnEpoch: 1, reason: 'provider-error', disposition: 'fatal' },
    })
    expect(svc.listOpen()).toHaveLength(0)
    // THE SHADOW ARRIVES SECOND — the ordering the old bit needed.
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'errored', error: { class: 'provider_refusal', retryable: false } }),
    })
    expect(svc.listOpen()).toHaveLength(0)
  })

  it('suppression does not depend on the causal event arriving FIRST', async () => {
    // The interleaving the in-memory bit got wrong: the shadow lands before the
    // causal event is projected. Provenance is a durable property of the
    // session, so the order cannot change the answer.
    const { svc } = harness({ causalSessions: [S] })
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'errored', error: { class: 'provider_refusal', retryable: false } }),
    })
    expect(svc.listOpen()).toHaveLength(0)
  })

  it('a session with NO causal stream still mints from the errored state', async () => {
    // The case this issue exists for: hook-driven Claude has no causal stream,
    // so the state path is the only evidence there is and must keep working.
    const { svc } = harness()
    await svc.onStateChanged({
      sessionId: S,
      prev: undefined,
      next: state({ phase: 'errored', error: { class: 'billing_error', retryable: false } }),
    })
    expect(svc.listOpen()).toHaveLength(1)
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

  it('a STRUCTURED resume-time recovery auto-answers over its own protocol', async () => {
    // The kind the spec is about: asked while the handle is STARTING, answered
    // by replying to the driver holding it. The keystroke form of the same ask
    // has no such route and is refused — see the review-round block above.
    const db = openMigratedTestDatabase()
    const store = new InteractionsRepository(db)
    let clock = 0
    const structured: unknown[] = []
    const service = new InteractionService({
      store,
      now: () => `2026-08-14T00:00:${String(clock++).padStart(2, '0')}.000Z`,
      publish: () => {},
      deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
      readTranscript: async () => ({ items: [] }),
      policyPrincipal: () => PRINCIPAL,
      deliverStructured: async (input) => {
        structured.push(input.answer)
        return { ok: true }
      },
    })
    await service.ask({
      interaction: {
        id: 'ixn_starting',
        sessionId: S,
        kind: 'recovery',
        payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
        source: 'protocol',
        answerable: 'structured',
      },
    })
    expect(structured).toEqual([{ kind: 'recovery', choice: 'full-resume' }])
    expect(service.listOpen()).toHaveLength(0)
  })

  it('an UNDELIVERABLE policy answer reopens the ask instead of swallowing it', async () => {
    // The deadlock POD-2414 closes: the default claimed the row, delivery
    // failed, and the row left `listOpen` and the feed — so a session stalled at
    // startup became a session stalled with nothing on any surface.
    const db = openMigratedTestDatabase()
    const store = new InteractionsRepository(db)
    let clock = 0
    const published: InteractionRow[] = []
    const service = new InteractionService({
      store,
      now: () => `2026-08-14T00:00:${String(clock++).padStart(2, '0')}.000Z`,
      publish: (row) => published.push(row),
      deliver: async () => ({ ok: true, via: 'menu', choices: [] }),
      readTranscript: async () => ({ items: [] }),
      policyPrincipal: () => PRINCIPAL,
      // Accepted by the port, then reported as UNDELIVERED — the case that used
      // to leave the row answered and off every surface.
      deliverStructured: async () => ({ ok: false, reason: 'delivery-failed' }),
    })
    await service.ask({
      interaction: {
        id: 'ixn_cache-miss',
        sessionId: S,
        kind: 'recovery',
        payload: { v: 1, reason: 'cache-miss', prompt: 'Resume?', offered: ['full-resume'] },
        source: 'protocol',
        answerable: 'structured',
      },
    })
    expect(service.get('ixn_cache-miss')).toMatchObject({
      status: 'asked',
      policyVerdict: 'escalated',
    })
    expect(service.listOpen()).toHaveLength(1)
    // The surfaces saw it open, then answered, then open again — the last word
    // is what a replica keeps.
    expect(published.at(-1)).toMatchObject({ status: 'asked' })
  })

  it('a THROWN keystroke send stays resolved, because it may have landed', async () => {
    // THE LINE THIS PAIR DRAWS (POD-2414 third pass). This test used to feed a
    // REFUSAL and conclude that keystroke failures are unprovable in general.
    // They are not: a refusal is a pre-send guard and proves nothing was typed
    // (see the reopen test above). A THROW is the genuinely unknowable case —
    // the reply may have been applied and the transport lost on the way back —
    // so the claim and `unverified` stay, because reopening could put a second
    // set of digits into a menu that already moved.
    const { svc, store } = harness({
      delivery: () => {
        throw new Error('relay died mid-send')
      },
    })
    store.insert(recoveryRow('context-overflow'))
    const outcome = await svc.answer({
      id: 'ixn_context-overflow',
      answer: { kind: 'recovery', choice: 'full-resume' },
      answeredBy: 'human',
      principal: PRINCIPAL,
    })
    // The row keeps its claim, and the CALLER is still told it failed — the
    // half that used to report `ok: true`.
    expect(outcome).toMatchObject({ ok: false, reason: 'delivery-failed' })
    expect(svc.get('ixn_context-overflow')).toMatchObject({
      status: 'answered',
      answeredBy: 'human',
      deliveredVia: 'unverified',
    })
    expect(svc.listOpen(S)).toEqual([])
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
